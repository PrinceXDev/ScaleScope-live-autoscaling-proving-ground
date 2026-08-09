/**
 * The collector: ingest, projection, and the one place cost is metered.
 *
 * This is the busiest service in the fleet by message volume and the only one
 * whose failure mode is "take down the thing it's measuring by falling over
 * under its own ingest load" -- so almost everything below is written around
 * bounding memory and never blocking on a slow downstream.
 */

import http from 'node:http';
import {
  TELEMETRY, EVENT, UNKNOWN_INSTANCE, mergeSamples, estimateCost,
  QUEUE_COLLECTOR, ORACLE, UI,
} from '@scalescope/contracts';
import { connectBus, ensureStreams, subscribe, pub, broadcast, appendEvent } from '@scalescope/bus';
import { connectValkey, LiveWindow, chInsert, ensureClickhouse } from '@scalescope/stores';
import { log } from '@scalescope/telemetry';
import {
  BucketAccumulator, ScaleTracker, SloTracker, PhaseTracker, WATERMARK_LAG_MS,
} from './projections.js';

process.env.SCALESCOPE_SERVICE = 'collector';

const PORT = Number(process.env.PORT || 3000);

/**
 * A pending-rows cap, enforced before every push.
 *
 * An unbounded array here is the single most likely way this project takes
 * itself down: ClickHouse having a slow moment, or the network to it blipping,
 * turns "buffer one second of writes" into "buffer every write since the
 * outage started," and a load generator whose own collector is busy growing an
 * array is not measuring anything anymore. Past the cap we drop the oldest rows
 * -- shedding load with a visible, counted drop is a survivable, honest failure;
 * growing until the process OOMs is not.
 */
const MAX_PENDING_ROWS = Number(process.env.MAX_PENDING_ROWS || 20_000);

/** How stale a fleet-wide window has to be before its container count decays to zero even with no new samples. */
const CONTAINER_WINDOW_MS = Number(process.env.CONTAINER_WINDOW_MS || 10_000);

let droppedRows = 0;
let pending = [];

const buckets = new BucketAccumulator();
const scaleTracker = new ScaleTracker();
const sloTracker = new SloTracker();
const phaseTracker = new PhaseTracker();

/** runId -> cumulative container-seconds this process has observed, for the running cost figure on the live chart. Recomputed from the durable log at finalisation, so a collector restart mid-run degrades the live number but never the final one. */
const containerSeconds = new Map();

/** runId -> config, learned from run.started broadcasts, needed for SLO threshold and setpoint echo. */
const runMeta = new Map();

function pushRow(row) {
  if (pending.length >= MAX_PENDING_ROWS) {
    pending.shift();
    droppedRows += 1;
  }
  pending.push(row);
}

async function flushBucket(bucket, nc, js) {
  const frame = mergeSamples(bucket.samples, { runId: bucket.runId });
  const meta = runMeta.get(bucket.runId) || {};

  // Rolling container presence lives in Valkey, not in this process's memory,
  // because the collector is meant to be able to scale to more than one
  // container. A count kept locally would answer "how many instances has THIS
  // collector container observed", and two collector containers splitting the
  // sample stream would each report a fraction of the real count -- exactly
  // the split-brain bug a per-container Set produces, just one layer down from
  // where the build plan originally warned about it on the gateway.
  const now = bucket.samples[0]?.wallMs ?? Date.now();
  for (const inst of frame.instances) {
    await LiveWindow.observe(bucket.runId, inst.id, now).catch(() => {});
  }
  const containers = await LiveWindow.count(bucket.runId, now, CONTAINER_WINDOW_MS).catch(() => frame.containers);
  frame.containers = containers;

  const prevSeconds = containerSeconds.get(bucket.runId) || 0;
  const nextSeconds = prevSeconds + containers;
  containerSeconds.set(bucket.runId, nextSeconds);
  frame.containerSeconds = nextSeconds;
  frame.costUsd = estimateCost(nextSeconds);
  frame.ingestLagMs = Date.now() - now;

  broadcast(nc, 'tick', frame);
  await appendEvent(js, bucket.runId, EVENT.TICK, frame, 'collector', bucket.t).catch((err) =>
    log.warn(`append TICK failed for ${bucket.runId}@${bucket.t}: ${err.message}`));

  const scaled = scaleTracker.observe(bucket.runId, containers);
  if (scaled) {
    const payload = { runId: bucket.runId, t: bucket.t, ...scaled };
    broadcast(nc, 'scaled', payload);
    await appendEvent(js, bucket.runId, EVENT.SCALED, payload, 'collector').catch(() => {});
    log.info(`run ${bucket.runId} scaled ${scaled.from} -> ${scaled.to} at t=${bucket.t}`);
  }

  const sloThreshold = meta.sloP95Ms;
  if (sloThreshold) {
    const sloEvt = sloTracker.observe(bucket.runId, bucket.t, frame.p95, sloThreshold);
    if (sloEvt) {
      const payload = { runId: bucket.runId, thresholdMs: sloThreshold, p95: frame.p95, ...sloEvt };
      broadcast(nc, 'slo', payload);
      await appendEvent(js, bucket.runId, EVENT.SLO, payload, 'collector').catch(() => {});
    }
  }

  const phaseChanged = phaseTracker.observe(bucket.runId, frame.phase);
  if (phaseChanged) {
    const payload = { runId: bucket.runId, phase: phaseChanged, t: bucket.t };
    broadcast(nc, 'phase', payload);
    await appendEvent(js, bucket.runId, EVENT.PHASE, payload, 'collector').catch(() => {});
  }

  for (const inst of frame.instances) {
    pushRow({
      run_id: bucket.runId,
      ts: new Date(bucket.samples[0]?.wallMs ?? Date.now()).toISOString().replace('T', ' ').slice(0, 23),
      t: bucket.t,
      phase: frame.phase,
      worker_id: bucket.samples.find((s) => s.targetInstance === inst.id)?.workerId ?? 'unknown',
      target_instance: inst.id,
      instance_age_ms: inst.ageMs ?? 0,
      requests: inst.requests,
      errors: 0,
      concurrency: frame.concurrency,
      p50_ms: frame.p50,
      p95_ms: inst.p95,
      p99_ms: frame.p99,
      setpoint_ms: frame.setpointMs ?? 0,
    });
  }
  // Errors and the UNKNOWN_INSTANCE marker are attributed to a synthetic row
  // rather than smeared across real instances, so `run_instances` (which
  // filters UNKNOWN_INSTANCE out) never has its per-container request counts
  // inflated by requests nothing actually served.
  if (frame.errors > 0 || frame.instances.length === 0) {
    pushRow({
      run_id: bucket.runId,
      ts: new Date(bucket.samples[0]?.wallMs ?? Date.now()).toISOString().replace('T', ' ').slice(0, 23),
      t: bucket.t,
      phase: frame.phase,
      worker_id: 'fleet',
      target_instance: UNKNOWN_INSTANCE,
      instance_age_ms: 0,
      requests: 0,
      errors: frame.errors,
      concurrency: 0,
      p50_ms: 0,
      p95_ms: 0,
      p99_ms: 0,
      setpoint_ms: 0,
    });
  }

  pub(nc, ORACLE.OBSERVE, frame);
}

async function main() {
  log.info('booting collector');

  await connectValkey('collector');

  const nc = await connectBus('collector');
  const js = nc.jetstream();
  await ensureStreams(nc);

  // ClickHouse's own migration is idempotent and gateway usually wins the
  // race, but a fresh `zcli project import` might bring the collector up
  // first, so this is not skipped -- just tolerant of failure.
  try {
    await ensureClickhouse(new URL('../../../infra/migrations/clickhouse', import.meta.url).pathname);
  } catch (err) {
    log.warn(`clickhouse ensure skipped: ${err.message}`);
  }

  subscribe(nc, TELEMETRY.SAMPLE, (sample) => {
    if (!sample?.runId || sample.t == null) return;
    buckets.add(sample);
  }, { queue: QUEUE_COLLECTOR });

  // Learn each run's SLO threshold from its own start broadcast rather than
  // querying Postgres per tick -- a run's config does not change after it
  // starts (setpoint retargeting is the one exception and arrives on its own
  // subject), so caching it here removes a database round trip from the
  // hottest loop in the service.
  subscribe(nc, UI.BROADCAST, ({ event, data }) => {
    if (event === 'run.started' && data?.config) {
      runMeta.set(data.runId, { sloP95Ms: data.config.sloP95Ms });
    }
    if (event === 'run.completed' || event === 'run.failed') {
      // Force out any bucket for this run still waiting on the watermark, so
      // the very last second of a run is never lost to timing.
      for (const bucket of buckets.drainAll(data.runId)) {
        flushBucket(bucket, nc, js).catch((err) => log.error(`final flush failed: ${err.message}`));
      }
      containerSeconds.delete(data.runId);
      runMeta.delete(data.runId);
      scaleTracker.clear(data.runId);
      sloTracker.clear(data.runId);
      phaseTracker.clear(data.runId);
    }
  });

  // The watermark sweep runs independently of message arrival. A run that goes
  // completely silent (every worker died) must still have its last bucket
  // flushed once the lag elapses, and tying the sweep to "a new sample arrived"
  // would never trigger that.
  setInterval(() => {
    for (const bucket of buckets.drainFlushable(WATERMARK_LAG_MS)) {
      flushBucket(bucket, nc, js).catch((err) => log.error(`flush failed: ${err.message}`));
    }
  }, 250);

  // One batched insert per second. Never per row -- see the comment on
  // chInsert in @scalescope/stores for why a per-row insert against ClickHouse
  // degrades into a merge storm within minutes of real traffic.
  setInterval(async () => {
    if (pending.length === 0) return;
    const rows = pending;
    pending = [];
    try {
      await chInsert('samples', rows);
    } catch (err) {
      log.error(`clickhouse insert failed (${rows.length} rows): ${err.message}`);
      // Re-queue once, at the front, bounded by the same cap as fresh rows so a
      // sustained outage still sheds load instead of retrying forever.
      pending = [...rows, ...pending].slice(-MAX_PENDING_ROWS);
    }
  }, 1000);

  setInterval(() => {
    pub(nc, TELEMETRY.WATERMARK, {
      pendingBuckets: buckets.pendingCount,
      pendingRows: pending.length,
      droppedRows,
      at: Date.now(),
    });
  }, 5000);

  http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'collector', pendingBuckets: buckets.pendingCount, pendingRows: pending.length, droppedRows }));
      return;
    }
    res.writeHead(404).end();
  }).listen(PORT, () => log.info(`collector healthz on ${PORT}`));

  log.info('collector ready');
}

main().catch((err) => {
  log.error(`fatal collector startup error: ${err.stack || err.message}`);
  process.exit(1);
});
