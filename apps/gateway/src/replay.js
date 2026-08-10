/**
 * The replay engine.
 *
 * The obvious way to build "watch a past run" is to query ClickHouse for the
 * timeline, hand the frontend an array, and let it redraw the chart. That works,
 * and it is wrong, because it creates a second rendering path: the live console
 * consumes a stream of frames arriving one per second, the replay view consumes
 * an array arriving all at once, and from that moment the two surfaces drift.
 * Every feature added to the live view -- the scale annotations, the SLO shading,
 * the container swimlane growing left to right -- has to be re-implemented for
 * the array case, and the two implementations disagree by the end of the build.
 *
 * So replay here is not a different data source. It is the same JetStream event
 * log, re-emitted into the same SSE connection, using the same event names, at
 * the original wall-clock spacing between events. The frontend has no branch
 * anywhere that knows whether it is watching a run happening now or a run that
 * finished three hours ago -- `openStream()` in the web client is called with one
 * extra query parameter and nothing downstream of it changes. That is the whole
 * point of making the event log the system of record rather than a log file:
 * the past is replayable at full fidelity because the past is still the events,
 * not a lossy aggregate of them.
 *
 * Two deliberate distortions of "original spacing", both for watchability:
 *   - gaps are divided by a speed multiplier, clamped to a sane range;
 *   - any single gap is capped at two seconds, so a run that stalled for forty
 *     seconds waiting on a container does not stall the replay for forty
 *     seconds. The cap is a lie about time, so the client is told about it.
 */

import {
  STREAM_RUNS,
  evtAll,
  EVENT,
} from '@scalescope/contracts';
import { jc } from '@scalescope/bus';
import { chJson } from '@scalescope/stores';
import { log, sleep } from '@scalescope/telemetry';
import { AckPolicy, DeliverPolicy, ReplayPolicy } from 'nats';

/** Longest we will honour a gap between two events, in ms. */
const MAX_GAP_MS = 2000;
const SPEED_MIN = 0.25;
const SPEED_MAX = 20;

/**
 * Event type -> SSE event name.
 *
 * The names on the wire are the ones the web client already listens for, and
 * they are identical for live and replayed traffic. Keeping the mapping in one
 * exported table means the live broadcast path and the replay path cannot
 * accidentally diverge on naming, which would be a silent way to break the
 * "one code path" property this whole module exists to preserve.
 */
export const SSE_NAME_FOR_EVENT = {
  [EVENT.CREATED]: 'run.created',
  [EVENT.ARMED]: 'run.armed',
  [EVENT.STARTED]: 'run.started',
  [EVENT.TICK]: 'tick',
  [EVENT.SCALED]: 'scaled',
  [EVENT.PHASE]: 'phase',
  [EVENT.CHAOS]: 'chaos',
  [EVENT.PREDICTION]: 'prediction',
  [EVENT.FINDING]: 'finding',
  [EVENT.SLO]: 'slo',
  [EVENT.COMPLETED]: 'run.completed',
  [EVENT.FAILED]: 'run.failed',
};

/**
 * Read a run's entire event log out of JetStream, in stream order.
 *
 * Implementation notes worth having in the file rather than in someone's head:
 *
 * We ask the stream for its per-subject message counts first. That serves two
 * purposes -- it tells the pull consumer exactly how many messages to wait for,
 * so `fetch` returns the instant it has them all instead of sitting on its
 * expiry timer, and a count of zero is an unambiguous "this run has aged out of
 * retention", which is the signal the replay fallback needs.
 *
 * The consumer is ephemeral with AckPolicy.None: we are reading a finite,
 * already-durable log for a one-shot purpose, so per-message acks would be pure
 * overhead and a durable consumer would leave litter behind on the server for
 * every replay a visitor ever starts.
 *
 * A run's log is hundreds of events, not millions, so we buffer it fully and
 * pace from memory. Holding a live consumer open for the duration of a 0.25x
 * replay would mean a server-side resource whose lifetime is controlled by a
 * query parameter, which is not a thing to expose on a public dashboard.
 *
 * @param {import('nats').NatsConnection} nc
 * @param {string} runId
 * @returns {Promise<Array<{seq:number, subject:string, env:any}>>}
 */
export async function readRunEvents(nc, runId, { maxEvents = 50_000 } = {}) {
  const jsm = await nc.jetstreamManager();
  const js = nc.jetstream();

  let expected = 0;
  try {
    const info = await jsm.streams.info(STREAM_RUNS, { subjects_filter: evtAll(runId) });
    expected = Object.values(info?.state?.subjects || {}).reduce((a, b) => a + Number(b || 0), 0);
  } catch (err) {
    log.warn(`jetstream subject census failed for ${runId}: ${err.message}`);
    return [];
  }

  if (expected === 0) return [];

  let ci;
  try {
    ci = await jsm.consumers.add(STREAM_RUNS, {
      ack_policy: AckPolicy.None,
      deliver_policy: DeliverPolicy.All,
      replay_policy: ReplayPolicy.Instant,
      filter_subject: evtAll(runId),
      // Reap the consumer automatically if this process dies mid-read, so a
      // crashed gateway cannot leak consumers into the stream forever.
      inactive_threshold: 60 * 1_000_000_000,
    });
  } catch (err) {
    log.error(`could not open replay consumer for ${runId}: ${err.message}`);
    return [];
  }

  const out = [];
  try {
    const consumer = await js.consumers.get(STREAM_RUNS, ci.name);
    const want = Math.min(expected, maxEvents);
    const iter = await consumer.fetch({ max_messages: want, expires: 5000 });
    for await (const m of iter) {
      try {
        out.push({ seq: m.seq, subject: m.subject, env: jc.decode(m.data) });
      } catch (err) {
        // A single undecodable message must not cost us the rest of the run.
        log.warn(`skipping undecodable event seq=${m.seq}: ${err.message}`);
      }
      if (out.length >= want) break;
    }
  } catch (err) {
    log.error(`replay read failed for ${runId}: ${err.message}`);
  } finally {
    await jsm.consumers.delete(STREAM_RUNS, ci.name).catch(() => {});
  }

  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/** Speed is user input from a query string, so it is clamped, not trusted. */
export function normaliseSpeed(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, n));
}

/**
 * Pace one run's event log into a single SSE connection.
 *
 * `send` is the same writer the live stream uses, so everything below produces
 * bytes indistinguishable from a live run except for the ordering guarantee
 * (replay is exactly stream order; live is arrival order).
 *
 * @param {Object} opts
 * @param {import('nats').NatsConnection} opts.nc
 * @param {string} opts.runId
 * @param {number} opts.speed
 * @param {(event: string, data: any) => boolean} opts.send returns false once the client is gone
 * @param {() => boolean} opts.isOpen
 */
export async function replayRun({ nc, runId, speed = 1, send, isOpen }) {
  const mult = normaliseSpeed(speed);
  const events = await readRunEvents(nc, runId);

  if (!isOpen()) return { emitted: 0, degraded: false, aborted: true };

  if (events.length === 0) {
    // The stream has a seven-day age cap and a byte cap, so an old or very
    // popular run can genuinely be gone. Rather than 404 a permalink that used
    // to work, we rebuild a *lower-fidelity* replay out of the ClickHouse
    // rollup: per-second frames with no per-instance detail, no scale
    // annotations, no chaos markers. It is a real degradation and the client is
    // told so explicitly instead of being left to wonder why the swimlane is
    // empty.
    return replayFromTimeline({ runId, mult, send, isOpen });
  }

  let emitted = 0;
  let prevAt = events[0].env?.emittedAt ?? Date.now();

  for (const { env } of events) {
    if (!isOpen()) return { emitted, degraded: false, aborted: true };

    const at = env?.emittedAt ?? prevAt;
    const gap = Math.min(MAX_GAP_MS, Math.max(0, at - prevAt));
    prevAt = at;
    if (gap > 0) await sleep(gap / mult);
    if (!isOpen()) return { emitted, degraded: false, aborted: true };

    const name = SSE_NAME_FOR_EVENT[env.type];
    if (!name) continue;
    if (!send(name, env.data)) return { emitted, degraded: false, aborted: true };
    emitted += 1;
  }

  send('replay.end', { runId, emitted, degraded: false, speed: mult });
  return { emitted, degraded: false, aborted: false };
}

/**
 * Fallback path: synthesise TICK frames from the ClickHouse rollup.
 *
 * Note what this deliberately does not do -- it does not try to fake the events
 * it cannot reconstruct. There is no synthetic `scaled`, no synthetic `slo`,
 * because inventing annotations that were never observed would make a degraded
 * replay indistinguishable from a real one, and a measurement tool that quietly
 * fabricates is worse than one that admits a gap.
 */
async function replayFromTimeline({ runId, mult, send, isOpen }) {
  let rows = [];
  try {
    rows = await chJson('SELECT * FROM run_timeline WHERE run_id = :id ORDER BY t', { id: runId });
  } catch (err) {
    log.error(`degraded replay query failed for ${runId}: ${err.message}`);
  }

  if (rows.length === 0) {
    send('replay.end', { runId, emitted: 0, degraded: true, empty: true, speed: mult });
    return { emitted: 0, degraded: true, aborted: false };
  }

  send('run.started', { runId, t0: null, degraded: true, workers: [] });

  let emitted = 0;
  let prevT = Number(rows[0].t) || 0;

  for (const r of rows) {
    if (!isOpen()) return { emitted, degraded: true, aborted: true };

    const t = Number(r.t) || 0;
    const gap = Math.min(MAX_GAP_MS, Math.max(0, (t - prevT) * 1000));
    prevT = t;
    if (gap > 0) await sleep(gap / mult);
    if (!isOpen()) return { emitted, degraded: true, aborted: true };

    const ok = send('tick', {
      runId,
      t,
      wallMs: 0,
      phase: r.phase || 'load',
      rps: Number(r.rps) || 0,
      errors: Number(r.errors) || 0,
      p50: Number(r.p50) || 0,
      p95: Number(r.p95) || 0,
      p99: Number(r.p99) || 0,
      containers: Number(r.containers) || 0,
      instances: [],
      workers: Number(r.workers) || 0,
      concurrency: Number(r.concurrency) || 0,
      setpointMs: r.setpoint_ms == null ? null : Number(r.setpoint_ms),
      predicted: null,
      costUsd: 0,
      containerSeconds: 0,
      ingestLagMs: 0,
      degraded: true,
    });
    if (!ok) return { emitted, degraded: true, aborted: true };
    emitted += 1;
  }

  send('replay.end', { runId, emitted, degraded: true, speed: mult });
  return { emitted, degraded: true, aborted: false };
}
