/**
 * The load fleet: one worker's share of the pressure, and the measurement of
 * what came back.
 *
 * This file deliberately knows nothing about NATS. It is handed a `publish`
 * callback and it emits sample objects; index.js decides what a subject is.
 * The reason is not purity, it is testability -- the load engine is the part
 * most likely to be wrong in a way that quietly biases every chart in the
 * project, and being able to drive it against a local target with a console.log
 * for a bus is worth the one extra parameter.
 */

import http from 'node:http';
import https from 'node:https';
import { PROFILE, UNKNOWN_INSTANCE, intensityAt } from '@scalescope/contracts';
import {
  InstanceWindow,
  LatencyHistogram,
  bucketClock,
  clamp,
  log,
  sleep,
} from '@scalescope/telemetry';
import { LatencyAutopilot } from '@scalescope/control';

/**
 * One agent, created once, shared by every in-flight request this worker will
 * ever make.
 *
 * We use node:http directly rather than fetch, and the reason is measurement
 * integrity rather than taste. fetch (undici) manages its own connection pool
 * with its own limits and its own idea of when to open and retire sockets, and
 * none of that is visible or pinnable from here. At 200 concurrent requests
 * against one hostname, an implicit pool that decides to churn connections
 * means a meaningful fraction of every latency sample is TCP handshake plus
 * slow-start -- we would be measuring our own socket setup and attributing it
 * to the target. The chart would still look plausible. It would just be wrong,
 * and wrong in the direction that makes the target look worse exactly when load
 * is highest, which is the same shape as the finding we are trying to report.
 * That is the worst kind of measurement error: one that mimics the signal.
 *
 * An explicit keepAlive agent with unbounded sockets makes connection reuse
 * deterministic. After the warm-up in prepare(), essentially every request in
 * the run rides an already-open socket, so a latency sample is the target's
 * queueing plus the target's CPU and almost nothing else.
 *
 * maxSockets: Infinity is intentional. Capping sockets would silently convert
 * requested concurrency into queued-locally concurrency: the worker would
 * report "40 in flight" while actually holding 34 of them in its own outbound
 * queue, and the target's latency would look better than it is.
 */
const agentOpts = { keepAlive: true, maxSockets: Infinity, maxFreeSockets: 512, timeout: 60_000 };
const httpAgent = new http.Agent(agentOpts);
const httpsAgent = new https.Agent(agentOpts);

/** Per-request ceiling. A socket that never answers must not pin a loop slot. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Cheapest work the target will accept; used by the cooldown probe. */
const PROBE_ROUNDS = 1000;

/**
 * Apportion an integer total across weights using the largest-remainder method.
 *
 * Needed because `concurrency` is a worker-level quantity but our samples are
 * per target instance, and both mergeSamples() and the ClickHouse rollup SUM
 * concurrency across rows. Publishing the worker's full concurrency on each of
 * three per-instance rows would report three times the real in-flight count,
 * and the autopilot's own output would appear to triple the moment the platform
 * added containers -- a completely fabricated staircase, in the same place on
 * the chart where the real finding lives. Splitting proportionally by request
 * share keeps the fleet sum exactly equal to the true in-flight total.
 */
function apportion(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const floors = exact.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  return floors;
}

export class LoadFleet {
  /**
   * @param {Object} opts
   * @param {string} opts.workerId
   * @param {(sample: any) => void} opts.publishSample called once per observed
   *        target instance per bucket
   * @param {(phase: string, detail: any) => void} [opts.onPhase]
   */
  constructor({ workerId, publishSample, onPhase }) {
    this.workerId = workerId;
    this.publishSample = publishSample;
    this.onPhase = onPhase || (() => {});

    this.running = false;
    this.runId = null;
    this.config = null;
    this.myShare = 1;

    /** Target in-flight requests for this worker right now. */
    this.desired = 0;
    /** Loops currently alive. Slots are contiguous 0..loopCount-1. */
    this.loopCount = 0;
    /** In cooldown the loop paces itself to one request per second. */
    this.probeMode = false;

    this.clock = null;
    this.ceilingTimer = null;
    this.autopilot = null;
    this.setpointMs = null;

    /**
     * Fleet-wide-per-worker histogram, feeding the autopilot. Separate from the
     * per-instance histograms below because the controller needs one number for
     * "how is the system behaving", not one per container -- if it chased the
     * worst container it would back off every time the platform added a cold
     * one, which is precisely when it should be pushing harder.
     */
    this.agg = new LatencyHistogram();

    /**
     * Per-target-instance accumulators, reused across buckets rather than
     * reallocated. Each holds its own histogram so per-instance p95 is a real
     * measurement rather than the worker's p95 copied onto every row -- that
     * copy is what would make the "did the new container actually take load, or
     * is it just slow?" question unanswerable.
     *
     * The map persists for the whole run (bounded by containers ever seen, so
     * tens of entries at most) but entries with no activity in a bucket are NOT
     * published. That distinction is load-bearing: publishing a zero-request row
     * for a container we saw thirty seconds ago would keep it inside
     * uniqExact(target_instance) forever and the container count would never
     * come back down. The scale-down half of the curve would simply not exist.
     */
    this.instances = new Map();

    /**
     * Errors we could not attribute to a container -- connection refused, DNS
     * failure, timeout before any header arrived. There is no instance id to
     * hang them on, so they go to UNKNOWN_INSTANCE, which every consumer
     * excludes from the container count while still summing its errors.
     */
    this.unattributedErrors = 0;

    /**
     * The worker's own view of which containers are currently answering it.
     * Advisory only: a single worker is one load-balancer client and may simply
     * never be routed to a container that exists, so this number can legitimately
     * be lower than the truth. The authoritative count is the collector's, taken
     * across every worker. We keep it locally anyway because it makes the worker
     * log readable during a live demo, and because a worker that suddenly sees
     * zero containers is a useful local signal that something broke here rather
     * than there.
     */
    this.window = new InstanceWindow();

    this.target = null;
  }

  // -------------------------------------------------------------------------
  // Prepare / barrier
  // -------------------------------------------------------------------------

  /**
   * Warm up ahead of T0.
   *
   * This is the entire justification for having a two-phase barrier at all
   * rather than just broadcasting "go". The first request a Node process makes
   * to a hostname pays for a DNS lookup, a TCP handshake, and the lazy
   * construction of the agent's socket pool. That is tens of milliseconds on a
   * good day and, when every worker in the fleet does it simultaneously at T0,
   * it is a coordinated burst of connection setup that lands in the first
   * bucket of the run.
   *
   * The damage is specific and severe for this project: the first second of a
   * SPIKE profile is the single most important second on the chart, because it
   * is where we measure how long the platform takes to notice. If that second
   * is contaminated with our own setup cost, the reported reaction time is our
   * DNS resolver's, not Zerops'. Pre-warming during the barrier means the first
   * second of the spike is real load hitting warm sockets, and the number we
   * publish is a number about the platform.
   */
  async prepare(targetUrl) {
    this.target = new URL(targetUrl);

    try {
      // One throwaway request at the cheapest possible work level. We do not
      // record it -- it is the sacrifice that makes every subsequent sample
      // clean, and folding it into the histogram would put a cold-start outlier
      // in the run's very first p99.
      await this.#fire(PROBE_ROUNDS, { record: false });
      log.info(`worker ${this.workerId} warmed ${this.target.host}`);
    } catch (err) {
      // A failed warm-up is not fatal: the target may still be booting. We
      // still report ready, because refusing to arm would stall the whole
      // fleet's barrier on one slow container.
      log.warn(`warm-up failed (continuing): ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Run lifecycle
  // -------------------------------------------------------------------------

  /**
   * @param {Object} go
   * @param {string} go.runId
   * @param {number} go.t0 absolute epoch ms every worker starts from
   * @param {Object} go.config clamped RunConfig
   * @param {string[]} go.workers workers that acknowledged the barrier
   */
  start({ runId, t0, config, workers }) {
    if (this.running) {
      log.warn(`GO for ${runId} while ${this.runId} is running; ignoring`);
      return;
    }

    this.running = true;
    this.runId = runId;
    this.config = config;
    this.target = new URL(config.targetUrl);
    this.agg.reset();
    this.instances.clear();
    this.unattributedErrors = 0;
    this.window = new InstanceWindow();
    this.probeMode = false;
    this.desired = 0;
    this.loopCount = 0;

    /**
     * Fleet share.
     *
     * `maxConcurrency` is a fleet-wide budget, so each worker takes an equal
     * slice and the sum across workers is the number the operator asked for.
     * If we are not in the acknowledged list -- we booted late, or our READY was
     * lost -- we still take an equal share rather than idling. Idling would be
     * safer for the budget but would make the fleet quietly under-deliver load
     * with no visible symptom, which is worse than the honest failure: the run
     * overshoots by one worker's share, and the reported per-worker concurrency
     * sums to more than the requested budget, which is visible on the dashboard.
     * A measurable error beats an invisible one.
     */
    const n = Math.max(1, workers?.length || 1);
    this.myShare = 1 / n;

    const budget = Math.max(1, Math.floor(config.maxConcurrency * this.myShare));

    if (config.profile === PROFILE.AUTOPILOT) {
      this.setpointMs = config.setpointMs;
      this.autopilot = new LatencyAutopilot({
        setpointMs: config.setpointMs,
        minConcurrency: 1,
        maxConcurrency: budget,
      });
    } else {
      this.setpointMs = null;
      this.autopilot = null;
    }

    /**
     * Bucket boundaries come from the broadcast T0, never from a local
     * setInterval started when this worker happened to receive GO.
     *
     * Workers do not receive GO at the same instant -- NATS delivery, scheduler
     * jitter and container warmth spread it over tens of milliseconds. If each
     * worker then ran its own one-second interval from its own start moment,
     * every worker's bucket N would cover a different slice of wall clock, and
     * the collector's sum for bucket N would blend parts of two real seconds
     * from each worker. Throughput becomes an approximation, and worse, a step
     * change in load smears across two buckets on every chart: the vertical edge
     * of a SPIKE turns into a two-second ramp that looks like the target
     * responding gradually. We would be reporting our own clock skew as a
     * property of the system under test.
     *
     * Deriving boundaries from the shared epoch makes bucket N the identical
     * interval on every machine, so cross-worker sums are exact and the spike
     * edge stays vertical.
     */
    this.clock = bucketClock(t0, (index, wallMs) => this.#onBucket(index, wallMs));

    /**
     * Local, unconditional deadline.
     *
     * Every other stop path in this system depends on the control plane: a STOP
     * message from the gateway, which depends on NATS, which depends on the
     * gateway still being alive and still knowing this run exists. A load
     * generator whose only off switch is a message from somewhere else is a
     * credit-burning liability -- if the gateway crashes mid-run, this process
     * happily saturates the target forever, Zerops happily scales out to meet
     * it, and the first anyone knows is the balance. The failure is silent,
     * unattended, and bills by the hour.
     *
     * So the deadline lives here, is armed before the first request is sent, and
     * is not conditional on hearing anything from anyone. Thirty seconds of
     * slack past the declared run length absorbs normal scheduling jitter.
     */
    const ceilingMs = (config.durationS + config.cooldownS + 30) * 1000;
    this.ceilingTimer = setTimeout(() => {
      log.warn(`local ceiling hit for ${runId}; stopping without a STOP`);
      this.stop('local-ceiling');
    }, ceilingMs);
    this.ceilingTimer.unref?.();

    this.onPhase('load', { runId, t0 });
    log.info(
      `run ${runId} started profile=${config.profile} share=${this.myShare.toFixed(3)} budget=${budget}`,
    );

    // Seed bucket 0's concurrency so the first second is real load rather than
    // a second of silence while we wait for the first boundary.
    this.#applyDesired(0);
  }

  /** Live setpoint change. Only meaningful under autopilot. */
  retarget(setpointMs) {
    if (!Number.isFinite(setpointMs) || setpointMs <= 0) return;
    this.setpointMs = setpointMs;
    this.autopilot?.retarget(setpointMs);
    log.info(`setpoint -> ${setpointMs}ms`);
  }

  /** Idempotent. Loops finish their in-flight request and then exit. */
  stop(reason = 'stop') {
    if (!this.running) return;
    this.running = false;
    this.desired = 0;
    this.probeMode = false;
    this.clock?.stop();
    this.clock = null;
    if (this.ceilingTimer) clearTimeout(this.ceilingTimer);
    this.ceilingTimer = null;
    this.onPhase('idle', { runId: this.runId, reason });
    log.info(`run ${this.runId} stopped (${reason})`);
  }

  // -------------------------------------------------------------------------
  // Concurrency pool
  // -------------------------------------------------------------------------

  /**
   * Set the target concurrency and grow the pool to match.
   *
   * Shrinking is implicit and that is the whole trick. Each loop owns a slot
   * index and re-reads `this.desired` at the top of every iteration; when the
   * target drops below its slot, the loop returns. Nothing is cancelled, no
   * socket is destroyed mid-flight, and no request is abandoned after the target
   * has already spent CPU on it. An aborted request would be counted as an
   * error by us and as wasted work by the target -- so shedding load would show
   * up on the dashboard as the target failing, at exactly the moment the
   * autopilot is backing off because the target is struggling. The chart would
   * blame the victim.
   *
   * Slots are handed out contiguously and only the highest ones ever exit, so
   * the active set stays 0..loopCount-1 without any bookkeeping. Under a rapid
   * shrink-then-grow within a single in-flight request the pool can transiently
   * overshoot by one loop; that is accepted deliberately rather than taking a
   * mutex on the hot path of a load generator, and it self-corrects on the next
   * shrink.
   */
  #applyDesired(next) {
    this.desired = Math.max(0, Math.round(next));
    while (this.running && this.loopCount < this.desired) {
      const slot = this.loopCount;
      this.loopCount += 1;
      // Fire and forget, but never unhandled: #loop catches everything.
      void this.#loop(slot);
    }
  }

  async #loop(slot) {
    try {
      while (this.running && slot < this.desired) {
        if (this.probeMode) {
          // Cooldown pacing: one cheap request per second, self-correcting for
          // however long the request itself took.
          const startedAt = Date.now();
          await this.#fire(PROBE_ROUNDS);
          const rest = 1000 - (Date.now() - startedAt);
          if (rest > 0) await sleep(rest);
        } else {
          await this.#fire(this.config.rounds);
        }
      }
    } catch (err) {
      log.error(`loop ${slot} died: ${err.message}`);
    } finally {
      this.loopCount -= 1;
    }
  }

  // -------------------------------------------------------------------------
  // One request
  // -------------------------------------------------------------------------

  #statsFor(id) {
    let st = this.instances.get(id);
    if (!st) {
      st = { hist: new LatencyHistogram(), requests: 0, errors: 0, maxAgeMs: 0, active: false };
      this.instances.set(id, st);
    }
    return st;
  }

  /**
   * Issue one request and fold the result into this bucket's accumulators.
   * Never throws; a load generator that propagates a connection error into its
   * own control flow stops generating load at precisely the moment the data
   * gets interesting.
   */
  #fire(rounds, { record = true } = {}) {
    return new Promise((resolve) => {
      const isTls = this.target.protocol === 'https:';
      const lib = isTls ? https : http;
      const startedNs = process.hrtime.bigint();
      let settled = false;

      const finish = () => { if (!settled) { settled = true; resolve(); } };

      const req = lib.request(
        {
          protocol: this.target.protocol,
          hostname: this.target.hostname,
          port: this.target.port || (isTls ? 443 : 80),
          path: `${this.target.pathname}?rounds=${rounds}`,
          method: 'GET',
          agent: isTls ? httpsAgent : httpAgent,
          headers: { connection: 'keep-alive', 'x-scalescope-worker': this.workerId },
        },
        (res) => {
          const id = res.headers['x-instance-id'];
          const ageMs = Number(res.headers['x-instance-age']) || 0;

          // The body must be drained even though we never read it, or the socket
          // is never returned to the agent's free pool and keep-alive silently
          // degrades into connection-per-request -- the exact failure this whole
          // module is arranged to avoid.
          res.resume();

          res.on('end', () => {
            if (!record || !this.running) return finish();

            const latencyMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
            const ok = res.statusCode >= 200 && res.statusCode < 400;

            if (id) {
              this.window.observe(id);
              const st = this.#statsFor(id);
              st.active = true;
              st.maxAgeMs = Math.max(st.maxAgeMs, ageMs);
              if (ok) {
                st.requests += 1;
                // Latency is recorded for successful responses only, and this is
                // not a detail. An injected 503 comes back in about two
                // milliseconds because the target rejected it before doing any
                // work. Folding those into the histogram would drag p95 sharply
                // DOWN as the failure rate goes UP, so a partial outage would
                // render as a latency improvement. That is the single most
                // common way a load-test dashboard lies, and it lies most
                // convincingly during exactly the incident you built it to
                // observe. Errors get their own counter and their own line.
                st.hist.record(latencyMs);
                this.agg.record(latencyMs);
              } else {
                st.errors += 1;
              }
            } else if (!ok) {
              this.unattributedErrors += 1;
            }

            finish();
          });

          res.on('error', () => { this.unattributedErrors += 1; finish(); });
        },
      );

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        // destroy() rather than abort(): we want the socket gone, because a
        // timed-out socket is very likely attached to a container that is on its
        // way out and reusing it would poison later samples.
        req.destroy(new Error('timeout'));
      });

      req.on('error', () => {
        // No instance id was ever received, so there is nothing to attribute
        // this to. Connection refused during a scale-down, or a container we
        // just killed, both land here.
        if (record && this.running) this.unattributedErrors += 1;
        finish();
      });

      req.end();
    });
  }

  // -------------------------------------------------------------------------
  // Bucket boundary
  // -------------------------------------------------------------------------

  #onBucket(index, wallMs) {
    if (!this.running) return;

    const cfg = this.config;
    const loadBuckets = cfg.durationS;
    const totalBuckets = cfg.durationS + cfg.cooldownS;
    const phase = index < loadBuckets ? 'load' : 'cooldown';

    const observedP95 = this.agg.percentile(0.95);

    this.#publishBucket(index, wallMs, phase);

    // Reset accumulators for the bucket that starts now. Histograms are reset
    // rather than reallocated: constant memory is the whole reason for using a
    // histogram in a load generator, and allocating 460 fresh counters per
    // instance per second would hand it straight back.
    this.agg.reset();
    for (const st of this.instances.values()) {
      st.hist.reset();
      st.requests = 0;
      st.errors = 0;
      st.maxAgeMs = 0;
      st.active = false;
    }
    this.unattributedErrors = 0;

    const nextIndex = index + 1;

    if (nextIndex >= totalBuckets) {
      // The run's own clock says we are finished. This is the normal exit; the
      // local ceiling above only fires when this path failed to.
      this.stop('duration-elapsed');
      return;
    }

    if (nextIndex >= loadBuckets) {
      this.#enterCooldown(nextIndex);
      return;
    }

    // ---- load phase concurrency for the next bucket -----------------------
    const budget = Math.max(1, Math.floor(cfg.maxConcurrency * this.myShare));

    if (this.autopilot) {
      // The controller is fed the p95 we just measured, which is one bucket of
      // dead time by construction. That lag is real and is why the derivative
      // gain in LatencyAutopilot is kept small -- see the tuning notes there.
      const next = this.autopilot.update(observedP95, 1);
      this.#applyDesired(clamp(next, 1, budget));
    } else {
      const progress = nextIndex / Math.max(1, loadBuckets);
      const intensity = intensityAt(cfg.profile, progress);
      // Floor of one during the load phase: a profile trough that reaches zero
      // concurrency produces zero responses, and zero responses means zero
      // observed containers. The chart could not distinguish "we chose to stop
      // asking" from "every container is gone", which is the same argument as
      // the cooldown probe below, applied to the quiet parts of SPIKE and
      // SAWTOOTH.
      this.#applyDesired(Math.max(1, Math.round(intensity * budget)));
    }
  }

  /**
   * The cooldown probe.
   *
   * The instinct at the end of a run is to stop sending traffic. That instinct
   * destroys half the experiment, and the reason is worth stating plainly
   * because it is the least obvious design decision in this codebase.
   *
   * ScaleScope does not ask the platform how many containers exist. Container
   * count is derived entirely from distinct X-Instance-Id values observed in
   * responses, inside a rolling window. That measurement has one hard
   * precondition: we must be making requests. No requests means no responses,
   * no responses means no observed instance ids, and no observed instance ids
   * means the container count is not zero -- it is *undefined*. The chart simply
   * ends.
   *
   * Which means the scale-down half of the curve, the part where the platform
   * gives capacity back, would be literally unmeasurable. And that half is not
   * decoration: "it scaled up under load" is a claim about performance, whereas
   * "it scaled back down afterwards" is the claim about cost, and cost is the
   * entire commercial argument for autoscaling over just running six containers
   * permanently. A run that ends at peak proves the expensive half and asserts
   * the cheap half on faith.
   *
   * So we drop to a single loop issuing one deliberately cheap request per
   * second. One request per second at minimum rounds cannot hold a container
   * open -- it is far below any plausible scale-down threshold, and it costs a
   * rounding error of CPU -- but it is enough to keep observing, and observation
   * is all we need. The result is a complete 1 -> N -> 1 curve with a measured
   * descent, and the area under it is the number that makes the argument.
   */
  #enterCooldown(nextIndex) {
    if (!this.probeMode) {
      this.probeMode = true;
      this.onPhase('cooldown', { runId: this.runId, t: nextIndex });
      log.info(`run ${this.runId} entering cooldown probe at t=${nextIndex}s`);
    }
    this.#applyDesired(1);
  }

  /**
   * Publish one sample per observed target instance.
   *
   * The per-instance split is the reason the container curve exists. If this
   * worker collapsed its bucket into a single row -- one aggregate latency, one
   * request count -- then `uniqExact(target_instance)` downstream would count
   * one value per worker per second, and the answer to "how many containers are
   * serving?" would silently become "how many workers are running?". It would
   * not error. It would not look obviously wrong. It would just be a flat line
   * at the fleet size, and the central claim of the project would be
   * unsupported by its own data.
   */
  #publishBucket(index, wallMs, phase) {
    const rows = [];
    const weights = [];

    for (const [id, st] of this.instances) {
      // Only instances that actually answered during THIS bucket. See the
      // comment on `this.instances` for why publishing stale entries would
      // freeze the container count at its peak forever.
      if (!st.active) continue;
      const snap = st.hist.snapshot();
      rows.push({
        targetInstance: id,
        instanceAgeMs: st.maxAgeMs,
        requests: st.requests,
        errors: st.errors,
        p50: snap.p50,
        p95: snap.p95,
        p99: snap.p99,
      });
      weights.push(Math.max(1, st.requests));
    }

    // Concurrency is split across the rows so the fleet-wide SUM is the true
    // in-flight count. See apportion().
    const shares = apportion(this.desired, weights);

    const samples = rows.map((row, i) => ({
      runId: this.runId,
      workerId: this.workerId,
      t: index,
      wallMs,
      phase,
      targetInstance: row.targetInstance,
      instanceAgeMs: row.instanceAgeMs,
      requests: row.requests,
      errors: row.errors,
      concurrency: shares[i],
      p50: row.p50,
      p95: row.p95,
      p99: row.p99,
      setpointMs: this.setpointMs,
    }));

    // Errors with no instance attached still have to be reported, or a total
    // connection failure would look like a second with no traffic. They carry
    // zero concurrency so they cannot inflate the in-flight total, and
    // UNKNOWN_INSTANCE is excluded from every container count in the system.
    if (this.unattributedErrors > 0) {
      samples.push({
        runId: this.runId,
        workerId: this.workerId,
        t: index,
        wallMs,
        phase,
        targetInstance: UNKNOWN_INSTANCE,
        instanceAgeMs: 0,
        requests: 0,
        errors: this.unattributedErrors,
        concurrency: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        setpointMs: this.setpointMs,
      });
    }

    // Nothing at all came back this second. We publish anyway, because silence
    // and outage are different findings and a missing row is indistinguishable
    // from a worker that never started. An explicit zero-request row on
    // UNKNOWN_INSTANCE says "this worker was alive, was asking, and nothing
    // answered" -- which during a chaos kill is the most important second of the
    // whole run.
    if (samples.length === 0) {
      samples.push({
        runId: this.runId,
        workerId: this.workerId,
        t: index,
        wallMs,
        phase,
        targetInstance: UNKNOWN_INSTANCE,
        instanceAgeMs: 0,
        requests: 0,
        errors: 0,
        concurrency: this.desired,
        p50: 0,
        p95: 0,
        p99: 0,
        setpointMs: this.setpointMs,
      });
    }

    for (const s of samples) {
      try {
        this.publishSample(s);
      } catch (err) {
        // Telemetry is fire-and-forget by design (see subjects.js): a dropped
        // sample is a missing pixel. It must never take the load loop with it.
        log.error(`sample publish failed: ${err.message}`);
      }
    }
  }

  /** Snapshot for /healthz, so a container can be inspected mid-run. */
  status() {
    return {
      workerId: this.workerId,
      running: this.running,
      runId: this.runId,
      phase: this.probeMode ? 'cooldown' : (this.running ? 'load' : 'idle'),
      desiredConcurrency: this.desired,
      loops: this.loopCount,
      setpointMs: this.setpointMs,
      observedContainers: this.window.count(),
    };
  }
}
