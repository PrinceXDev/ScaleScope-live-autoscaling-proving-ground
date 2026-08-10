/**
 * Run orchestration: the control plane's only stateful job.
 *
 * Everything else in the gateway is a query. This file owns the lifecycle of a
 * run -- admission control, the synchronised start, and the fold that turns a
 * finished event log back into a row a human can read.
 */

import { randomUUID } from 'node:crypto';
import {
  CHAOS,
  CTRL,
  EVENT,
  clampRunConfig,
  estimateCost,
  foldRun,
} from '@scalescope/contracts';
import { appendEvent, broadcast, pub, subscribe } from '@scalescope/bus';
import {
  pgPool,
  chJson,
  RunLocks,
  CreditBudget,
  LiveWindow,
} from '@scalescope/stores';
import { log } from '@scalescope/telemetry';
import { readRunEvents } from './replay.js';

/** How long we are willing to wait for the fleet to arm before starting anyway. */
const BARRIER_TIMEOUT_MS = 2000;

/**
 * How long the barrier waits after the *last* ack before deciding the fleet has
 * finished answering. Two seconds of dead air on every run start is a bad demo;
 * four hundred milliseconds of quiet after the last worker replies is a good
 * proxy for "that is all of them".
 */
const BARRIER_QUIET_MS = 400;

/**
 * Lead time between broadcasting GO and the T0 it carries. It has to exceed
 * worst-case delivery plus scheduling jitter across the fleet, and stay short
 * enough that the button feels responsive. A second and a half does both.
 */
const T0_LEAD_MS = 1500;

/** Grace period after the run's nominal end before we fold and finalise. */
const FINALISE_GRACE_MS = 2000;

export const MAX_RUNS_PER_HOUR = Number(process.env.MAX_RUNS_PER_HOUR || 12);

/** Bus handles, injected on boot so this module has no import-time side effects. */
let nc = null;
let js = null;

/** runId -> finalisation timer, so a manual stop can cancel the scheduled one. */
const pendingFinalisers = new Map();

/** Guard against a stop and a timer both finalising the same run. */
const finalising = new Set();

/**
 * runId -> { lastFiredAt } for runs that opted into auto-chaos-on-finding.
 *
 * In-memory, not Postgres: it only needs to answer one question ("is this run
 * currently eligible, and how long since it last fired") on the hot path of a
 * finding arriving, and a gateway restart mid-run losing this state is an
 * acceptable failure mode -- the run itself, and every finding on it, is
 * still durably logged either way; only the auto-probe opt-in is lost, which
 * degrades to "no automatic follow-up chaos for the rest of this run", not
 * data loss.
 */
const autoChaosRuns = new Map();

/**
 * Minimum time between auto-fired chaos probes on the same run. A single
 * anomaly episode can produce a burst of findings in quick succession (one
 * per tick for as long as the divergence persists) -- without a cooldown
 * comfortably longer than one probe's own duration, each of those findings
 * would independently fire a new degrade command, continuously resetting the
 * target's degrade TTL and making it impossible to tell the original anomaly
 * apart from the system's own repeated probing of it.
 */
const AUTO_CHAOS_COOLDOWN_MS = Number(process.env.AUTO_CHAOS_COOLDOWN_MS || 45_000);
const AUTO_CHAOS_DURATION_S = 20;
const AUTO_CHAOS_DETAIL = { jitterMs: 800, failRate: 0.1 };

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export function initOrchestrator(ctx) {
  nc = ctx.nc;
  js = ctx.js;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/**
 * Start a run.
 *
 * ==========================================================================
 * WHY THERE IS A TWO-PHASE START BARRIER
 * ==========================================================================
 *
 * The naive version of this function publishes one "go" message and lets each
 * worker begin when it receives it. That is wrong in two distinct ways, and
 * both of them show up directly on the chart a judge is looking at.
 *
 * 1. THE SHAPE OF THE LOAD BECOMES THE SHAPE OF THE NETWORK.
 *
 *    Workers are containers on different machines. They receive the same
 *    message tens to hundreds of milliseconds apart, and a worker that has just
 *    been scheduled may need longer still to open its connection pool. If each
 *    one starts its profile from the moment its own message lands, then a SPIKE
 *    profile -- whose entire purpose is to be a vertical edge -- ramps up over
 *    the spread of message delivery instead. You asked the platform "what
 *    happens when load steps instantly?" and you actually asked it "what happens
 *    when load ramps over 300ms?", which is a different question with a
 *    different answer. Reaction time, the headline number for an autoscaler, is
 *    then measured from a start instant that never existed.
 *
 *    So: PREPARE tells the fleet to arm -- resolve DNS, warm the pool, build the
 *    profile -- and to acknowledge. Only once the fleet has acked does GO go out,
 *    and GO carries an absolute epoch T0 in the near future rather than meaning
 *    "now". Every worker waits for that wall-clock instant. The spike edge is
 *    vertical because the load actually was.
 *
 * 2. WITHOUT A SHARED T0, CROSS-WORKER SUMS ARE ESTIMATES.
 *
 *    Every worker aggregates into one-second buckets. If each derives its bucket
 *    boundaries from its own start time, worker A's second 12 overlaps worker
 *    B's seconds 11 and 12, and the collector adding them together is smearing
 *    two adjacent seconds into one. Requests-per-second becomes approximate,
 *    percentile aggregation becomes meaningless, and every edge in the chart
 *    softens by roughly the width of the clock skew.
 *
 *    Because GO carries one absolute T0 that every worker derives its bucket
 *    clock from (see `bucketClock` in @scalescope/telemetry), bucket N is the
 *    same interval of real time on every machine simultaneously. The collector's
 *    sum for bucket N is then exact rather than an estimate, and the container
 *    count attributed to second N is the count that was actually serving during
 *    second N.
 *
 * The cost of all this is one extra round trip and about 1.5 seconds of lead
 * time. The benefit is that every number the system produces is a measurement
 * rather than an approximation. That trade is the reason this project can claim
 * to measure an autoscaler rather than merely graph one.
 * ==========================================================================
 */
export async function startRun(input = {}) {
  requireBus();
  const config = clampRunConfig(input);
  const runId = randomUUID();

  // Admission control comes before anything that costs money or state. The
  // dashboard is public and one POST here spins up CPU-saturated containers on
  // a fixed credit balance, so the ceiling is enforced server-side in shared
  // state rather than by the frontend disabling a button.
  const budget = await CreditBudget.consume(MAX_RUNS_PER_HOUR);
  if (!budget.allowed) {
    throw new HttpError(429, 'hourly run budget exhausted', { budget });
  }

  // One target service means two concurrent runs would contaminate each other's
  // measurements. The lock makes that structurally impossible. TTL covers the
  // whole run plus a minute, so a gateway that dies mid-run cannot wedge the
  // system permanently -- the lock expires and the next run proceeds.
  const lockTtlS = config.durationS + config.cooldownS + 60;
  const gotLock = await RunLocks.acquire(runId, lockTtlS);
  if (!gotLock) {
    // The budget was consumed on the assumption this run would happen. It did
    // not, so give it back -- otherwise two people clicking at once burns two
    // credits and produces one run.
    await CreditBudget.refund().catch(() => {});
    const current = await RunLocks.current().catch(() => null);
    throw new HttpError(409, 'a run is already in progress', { currentRunId: current });
  }

  try {
    await insertRunRow(runId, config);

    if (config.autoChaosOnFinding) {
      autoChaosRuns.set(runId, { lastFiredAt: 0 });
    }

    const created = { runId, ...config };
    await appendEvent(js, runId, EVENT.CREATED, created, 'gateway');
    broadcast(nc, 'run.created', created);

    // ---- phase one: arm the fleet ----------------------------------------
    const workers = await armFleet(runId, config);
    await appendEvent(js, runId, EVENT.ARMED, { workers }, 'gateway');
    broadcast(nc, 'run.armed', { runId, workers });

    if (workers.length === 0) {
      // Not fatal: a run with no workers still produces a valid (empty) event
      // log, and failing hard here would turn a fleet that is still booting into
      // a broken-looking dashboard. It is logged loudly instead.
      log.warn(`run ${runId} armed with zero workers -- starting anyway`);
    }

    // ---- phase two: fire on a shared clock --------------------------------
    const t0 = Date.now() + T0_LEAD_MS;
    pub(nc, CTRL.GO, { runId, t0, config, workers });

    await appendEvent(js, runId, EVENT.STARTED, { runId, t0, workers, epochMs: t0 }, 'gateway');
    broadcast(nc, 'run.started', { runId, t0, workers, config });

    // $2 is cast explicitly on both uses. Left implicit, node-postgres tries to
    // infer one type for the placeholder from its first usage (bigint, for the
    // t0_ms column) and then chokes on the second usage expecting numeric for
    // to_timestamp() -- "inconsistent types deduced for parameter $2". Casting
    // removes the ambiguity instead of relying on the driver to guess right.
    await pgPool.query(
      `UPDATE runs SET t0_ms = $2::bigint, started_at = to_timestamp($2::bigint / 1000.0), status = 'running' WHERE id = $1`,
      [runId, t0],
    );

    scheduleFinalisation(runId, t0, config);

    log.info(`run ${runId} started: profile=${config.profile} t0=${t0} workers=${workers.length}`);
    return { runId, config, t0, workers, budget };
  } catch (err) {
    // Anything that fails after the lock is taken must give the lock and the
    // credit back, or one bad request takes the whole proving ground offline
    // until the TTL expires.
    await RunLocks.release(runId).catch(() => {});
    await CreditBudget.refund().catch(() => {});
    autoChaosRuns.delete(runId);
    await pgPool
      .query(`UPDATE runs SET status = 'failed', ended_at = now() WHERE id = $1`, [runId])
      .catch(() => {});
    await appendEvent(js, runId, EVENT.FAILED, { reason: err.message, endedAt: Date.now() }, 'gateway')
      .catch(() => {});
    throw err;
  }
}

/**
 * Phase one of the barrier: broadcast PREPARE and collect READY acks.
 *
 * The subscription is opened *before* PREPARE is published. Opening it after
 * would leave a window in which a fast worker's ack arrives before anyone is
 * listening, and that worker would then be missing from the ARMED event despite
 * having done everything right.
 *
 * The wait is bounded twice over: a hard ceiling so a dead fleet cannot hang the
 * request, and a quiet period so a live fleet does not pay the ceiling. Workers
 * are identified by a Set, because a worker that reconnects mid-arm can ack
 * twice and must not be counted twice.
 */
async function armFleet(runId, config) {
  const acks = new Set();

  return new Promise((resolve) => {
    let done = false;
    let quietTimer = null;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      sub.unsubscribe();
      resolve([...acks]);
    };

    const sub = subscribe(nc, CTRL.READY, (msg) => {
      if (!msg || msg.runId !== runId) return;
      const id = msg.workerId || msg.id;
      if (!id) return;
      acks.add(id);
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, BARRIER_QUIET_MS);
    });

    const hardTimer = setTimeout(finish, BARRIER_TIMEOUT_MS);

    pub(nc, CTRL.PREPARE, { runId, config, at: Date.now() });
  });
}

async function insertRunRow(runId, config) {
  await pgPool.query(
    `INSERT INTO runs (
       id, name, profile, target_url, rounds, max_concurrency,
       duration_s, cooldown_s, slo_p95_ms, setpoint_ms, chaos, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')`,
    [
      runId,
      config.name,
      config.profile,
      config.targetUrl,
      config.rounds,
      config.maxConcurrency,
      config.durationS,
      config.cooldownS,
      config.sloP95Ms,
      config.setpointMs,
      config.chaos ? JSON.stringify(config.chaos) : null,
    ],
  );
}

/**
 * Finalisation is scheduled from T0 rather than from now, because T0 is the
 * instant the run's own clock starts and every duration in the config is
 * expressed relative to it. Scheduling from `Date.now()` would drift by the
 * barrier's lead time on every run.
 */
function scheduleFinalisation(runId, t0, config) {
  const at = t0 + (config.durationS + config.cooldownS) * 1000 + FINALISE_GRACE_MS;
  const delay = Math.max(1000, at - Date.now());
  const timer = setTimeout(() => {
    pendingFinalisers.delete(runId);
    finishRun(runId, 'scheduled').catch((err) => log.error(`finalise ${runId}: ${err.message}`));
  }, delay);
  // A pending finaliser must not hold the process open during a deploy; the
  // lock TTL and the next boot's reconciliation are the real safety net.
  timer.unref?.();
  pendingFinalisers.set(runId, timer);
}

// ---------------------------------------------------------------------------
// Mid-run commands
// ---------------------------------------------------------------------------

export function stopFleet(runId, reason = 'operator') {
  requireBus();
  pub(nc, CTRL.STOP, { runId, reason, at: Date.now() });
}

export function setSetpoint(runId, setpointMs) {
  requireBus();
  pub(nc, CTRL.SETPOINT, { runId, setpointMs, at: Date.now() });
}

export async function stopRun(runId) {
  stopFleet(runId, 'operator');
  const timer = pendingFinalisers.get(runId);
  if (timer) {
    clearTimeout(timer);
    pendingFinalisers.delete(runId);
  }
  // Give the fleet a moment to stop reporting so the last few ticks are folded
  // into the summary rather than arriving after it was written.
  await new Promise((r) => setTimeout(r, 1200));
  return finishRun(runId, 'stopped');
}

/**
 * The auto-chaos feedback loop.
 *
 * Called for every EVENT.FINDING that crosses the bus, for every run --
 * `autoChaosRuns` is the opt-in gate, checked first so this is a no-op for
 * the overwhelming majority of findings on runs that never asked for it.
 *
 * The probe itself is fixed and deliberately mild (a `degrade`, never
 * `kill`), because the point is to test whether the anomaly the oracle just
 * flagged reproduces under a controlled, scoped condition -- not to stress
 * the target further while it may already be struggling. Proportionally
 * scaling the probe to the finding's absError was considered and rejected:
 * a bigger probe would make it harder to tell "the anomaly reproduced" from
 * "we hit it harder this time".
 *
 * `command.triggeredBy` carries the finding's own id forward onto both the
 * intent-side EVENT.CHAOS (appended here) and, once chaos/src/index.js
 * forwards it, the effect-side one too -- so a run's timeline can answer
 * "why did chaos fire here" with a real foreign key, not a guess from
 * adjacent timestamps.
 */
export async function maybeAutoChaos(finding) {
  requireBus();
  const { runId, findingId } = finding;
  const entry = autoChaosRuns.get(runId);
  if (!entry) return;

  const sinceLastFire = Date.now() - entry.lastFiredAt;
  if (sinceLastFire < AUTO_CHAOS_COOLDOWN_MS) {
    log.info(`auto-chaos skipped for run ${runId}: cooldown active (${Math.round((AUTO_CHAOS_COOLDOWN_MS - sinceLastFire) / 1000)}s left)`);
    return;
  }
  entry.lastFiredAt = Date.now();

  const command = {
    runId,
    kind: 'degrade',
    detail: AUTO_CHAOS_DETAIL,
    durationS: AUTO_CHAOS_DURATION_S,
    at: Date.now(),
    triggeredBy: findingId,
    reason: 'auto-chaos-on-finding',
  };

  pub(nc, CHAOS.COMMAND, command);
  await appendEvent(js, runId, EVENT.CHAOS, command, 'gateway');
  broadcast(nc, 'chaos', command);
  log.info(`auto-chaos degrade fired for run ${runId}, triggered by finding ${findingId}`);
}

// ---------------------------------------------------------------------------
// Finalisation: fold the log, write the projections
// ---------------------------------------------------------------------------

/**
 * Turn a finished run's event log into the denormalised row the history list
 * reads.
 *
 * This is the CQRS claim made concrete. The summary is not accumulated in
 * memory while the run happens -- a gateway restart mid-run would lose it, and a
 * second gateway container would have a different copy. It is computed once, at
 * the end, by replaying the durable log through `foldRun`, which is the same
 * function the REST layer and the scheduler use to answer "what is the state of
 * this run". One definition of run state, three consumers, no drift.
 */
export async function finishRun(runId, reason = 'scheduled') {
  requireBus();
  if (finalising.has(runId)) return null;
  finalising.add(runId);

  try {
    const events = await readRunEvents(nc, runId);
    const folded = foldRun(events.map((e) => ({ type: e.env.type, data: e.env.data, seq: e.seq })));

    if (folded.status === 'completed' || folded.status === 'failed') {
      // Already terminal -- a stop and the scheduled timer raced and the other
      // one won. Releasing the lock again is harmless and idempotent.
      await RunLocks.release(runId).catch(() => {});
      return folded;
    }

    const containerSeconds = folded.containerSeconds || 0;
    const summary = {
      runId,
      endedAt: Date.now(),
      reason,
      ticks: folded.ticks,
      peakContainers: folded.peakContainers,
      peakRps: Math.round(folded.peakRps),
      peakP95Ms: folded.peakP95,
      minP95Ms: folded.minP95,
      timeToRecoverS: folded.timeToRecoverS,
      containerSeconds,
      totalRequests: Math.round(folded.totalRequests),
      totalErrors: Math.round(folded.totalErrors),
      // Cost is recomputed from container-seconds here rather than trusting the
      // running total carried on the last tick, so a dropped final frame cannot
      // silently under-report spend.
      estCostUsd: estimateCost(containerSeconds),
      scaleEvents: folded.scaleEvents.length,
      chaosEvents: folded.chaosEvents.length,
      findingEvents: folded.findingEvents.length,
    };

    await pgPool.query(
      `UPDATE runs SET
         status = 'completed',
         ended_at = now(),
         peak_containers = $2,
         peak_rps = $3,
         peak_p95_ms = $4,
         min_p95_ms = $5,
         time_to_recover_s = $6,
         container_seconds = $7,
         total_requests = $8,
         total_errors = $9,
         est_cost_usd = $10
       WHERE id = $1`,
      [
        runId,
        summary.peakContainers,
        summary.peakRps,
        summary.peakP95Ms,
        summary.minP95Ms,
        summary.timeToRecoverS,
        summary.containerSeconds,
        summary.totalRequests,
        summary.totalErrors,
        summary.estCostUsd,
      ],
    );

    await upsertInstances(runId);

    await appendEvent(js, runId, EVENT.COMPLETED, summary, 'gateway');
    broadcast(nc, 'run.completed', summary);

    await RunLocks.release(runId).catch(() => {});
    await LiveWindow.clear(runId).catch(() => {});

    log.info(
      `run ${runId} completed (${reason}): peak=${summary.peakContainers} containers, `
      + `${summary.totalRequests} requests, $${summary.estCostUsd.toFixed(4)}`,
    );
    return summary;
  } catch (err) {
    log.error(`finalisation failed for ${runId}: ${err.message}`);
    // The lock outlives a failed finalisation only up to its TTL, but releasing
    // it here means the next run is not blocked by our bug.
    await RunLocks.release(runId).catch(() => {});
    throw err;
  } finally {
    finalising.delete(runId);
    autoChaosRuns.delete(runId);
  }
}

/**
 * Persist the container lifecycle table.
 *
 * Two sources, deliberately merged rather than picked between. Valkey holds the
 * live window -- birth and last-seen wall-clock times, which is what the
 * swimlane's x-axis needs -- but it is ephemeral and expires. ClickHouse holds
 * the per-instance request attribution, which is what the swimlane's shading
 * needs, but it knows time only in seconds-since-T0. Neither alone can answer
 * "when did this container appear and how much traffic did it actually take",
 * which is the question that distinguishes a container that scaled up and
 * helped from one that scaled up and sat idle.
 */
async function upsertInstances(runId) {
  let lifetimes = [];
  let attribution = [];

  try {
    lifetimes = await LiveWindow.lifetimes(runId);
  } catch (err) {
    log.warn(`instance lifetimes unavailable for ${runId}: ${err.message}`);
  }

  try {
    attribution = await chJson(
      'SELECT * FROM run_instances WHERE run_id = :id',
      { id: runId },
    );
  } catch (err) {
    log.warn(`instance attribution unavailable for ${runId}: ${err.message}`);
  }

  const byId = new Map();
  for (const l of lifetimes) {
    byId.set(l.id, {
      id: l.id,
      firstSeenMs: l.born,
      lastSeenMs: l.lastSeen,
      requests: 0,
      peakP95: null,
      maxAgeMs: null,
    });
  }
  for (const a of attribution) {
    const id = a.target_instance;
    const row = byId.get(id) || { id, firstSeenMs: 0, lastSeenMs: 0, requests: 0, peakP95: null, maxAgeMs: null };
    row.requests = Number(a.requests) || 0;
    row.peakP95 = Number(a.peak_p95) || null;
    row.maxAgeMs = Number(a.max_age_ms) || null;
    byId.set(id, row);
  }

  for (const row of byId.values()) {
    // Boot time is inferred, not reported: the target tells us its age in a
    // response header, so (last observation) minus (age at that observation) is
    // the epoch it started. That is how the swimlane can show containers that
    // existed before we ever sent them a request.
    const bootMs = row.maxAgeMs != null && row.lastSeenMs
      ? row.lastSeenMs - row.maxAgeMs
      : null;

    await pgPool.query(
      `INSERT INTO instances (run_id, instance_id, first_seen_ms, last_seen_ms, boot_ms, requests, peak_p95_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (run_id, instance_id) DO UPDATE SET
         first_seen_ms = LEAST(instances.first_seen_ms, EXCLUDED.first_seen_ms),
         last_seen_ms  = GREATEST(instances.last_seen_ms, EXCLUDED.last_seen_ms),
         boot_ms       = COALESCE(EXCLUDED.boot_ms, instances.boot_ms),
         requests      = GREATEST(instances.requests, EXCLUDED.requests),
         peak_p95_ms   = GREATEST(COALESCE(instances.peak_p95_ms, 0), COALESCE(EXCLUDED.peak_p95_ms, 0))`,
      [runId, row.id, row.firstSeenMs || 0, row.lastSeenMs || 0, bootMs, row.requests, row.peakP95],
    ).catch((err) => log.warn(`instance upsert ${row.id}: ${err.message}`));
  }
}

function requireBus() {
  if (!nc || !js) throw new HttpError(503, 'gateway is still booting');
}
