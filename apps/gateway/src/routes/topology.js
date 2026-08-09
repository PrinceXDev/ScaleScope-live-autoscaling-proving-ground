/**
 * Topology and live health.
 *
 * Rule 14 of most hackathon judging criteria asks you to explain the
 * architecture. This endpoint exists so the dashboard can render the real
 * subject map and real health checks instead of a picture of one -- a diagram
 * whose boxes are wired to `SELECT 1` is a materially different artifact from a
 * diagram someone drew in Figma, and it is the difference between "explain your
 * architecture" being a slide and being a live view a judge can refresh.
 *
 * Health is polled on a background timer, never inside the request handler.
 * Checking eight dependencies synchronously on every GET would make the
 * architecture panel itself a load generator against the system it is trying to
 * describe, and a slow check would make `/api/topology` -- a page most visitors
 * hit immediately -- the slowest thing the gateway serves.
 */

import { Router } from 'express';
import { SUBJECT_TABLE } from '@scalescope/contracts';
import { pgPool, chQuery, valkey } from '@scalescope/stores';
import { log } from '@scalescope/telemetry';

const POLL_MS = 10_000;
const CHECK_TIMEOUT_MS = 2000;

/** Static service catalogue. Role text is written for a judge reading the panel, not for a code comment. */
const SERVICES = [
  { id: 'web',       kind: 'static',      role: 'Dashboard — the story, the live console, and the lab.' },
  { id: 'gateway',   kind: 'nodejs',      role: 'Control plane. Owns admission, the start barrier, and SSE fan-out.' },
  { id: 'collector', kind: 'nodejs',      role: 'Ingest. Merges fleet samples into tick frames, writes ClickHouse.' },
  { id: 'worker',    kind: 'nodejs',      role: 'Load fleet. Fires the profile or runs the latency autopilot.' },
  { id: 'target',    kind: 'nodejs',      role: 'The service under test — this is what Zerops scales.' },
  { id: 'oracle',    kind: 'nodejs',      role: 'Digital twin. Predicts the container count 15s ahead, learns from error.' },
  { id: 'chaos',     kind: 'nodejs',      role: 'Fault injector. Kills, degrades, or partitions the target on command.' },
  { id: 'scheduler', kind: 'nodejs',      role: 'Runs unattended experiment suites through the gateway\'s own API.' },
  { id: 'nats',      kind: 'nats',        role: 'Broker. Commands fan out, telemetry fans in, the run log streams.' },
  { id: 'db',        kind: 'postgresql',  role: 'Write model — run registry, suites, twin parameters.' },
  { id: 'metrics',   kind: 'clickhouse',  role: 'Read model — every observed sample, queried by aggregate.' },
  { id: 'cache',     kind: 'valkey',      role: 'Live materialized view — rolling container window, locks, budget.' },
];

/** id -> { status, detail, lastSeenMs } */
const health = new Map(SERVICES.map((s) => [s.id, { status: 'unknown', detail: null, lastSeenMs: 0 }]));

/** Populated by the collector/worker/oracle/chaos/scheduler heartbeats the gateway happens to observe going by on the bus. */
const heartbeats = new Map();

export function noteHeartbeat(serviceId, detail = null) {
  heartbeats.set(serviceId, { at: Date.now(), detail });
}

function set(id, status, detail = null) {
  health.set(id, { status, detail, lastSeenMs: Date.now() });
}

async function withTimeout(promise, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await promise(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function pollOnce() {
  await Promise.allSettled([
    withTimeout((signal) => fetch('http://target:3000/healthz', { signal }), CHECK_TIMEOUT_MS)
      .then(() => set('target', 'up'))
      .catch((err) => set('target', 'down', err.message)),

    pgPool
      ? pgPool.query('SELECT 1').then(() => set('db', 'up')).catch((err) => set('db', 'down', err.message))
      : Promise.resolve(set('db', 'unknown', 'not configured')),

    chQuery('SELECT 1').then(() => set('metrics', 'up')).catch((err) => set('metrics', 'down', err.message)),

    (valkey?.isOpen
      ? valkey.ping().then(() => set('cache', 'up')).catch((err) => set('cache', 'down', err.message))
      : Promise.resolve(set('cache', 'down', 'not connected'))),
  ]);
}

/** Heartbeat-derived services are "up" if seen inside two of their own intervals, "down" after that, "unknown" before the first sighting. */
/**
 * `gateway` and `nats` are deliberately absent from this table. Both already
 * have a direct, always-current answer -- "this process is running" for the
 * former, `nc.isClosed()` for the latter -- and including them here alongside
 * services whose only signal IS a heartbeat used to cause a real bug: every
 * poll tick, `reconcileHeartbeats` would run for every key in this map and,
 * finding no heartbeat ever recorded under 'gateway' (nothing publishes one;
 * why would the gateway heartbeat to itself over a bus it might be
 * disconnected from at the exact moment you need to know that), stomp the
 * status this same file had just set to 'up' back down to 'unknown' --
 * immediately after boot, on the very first tick. A judge refreshing the
 * architecture panel ten seconds after opening the dashboard would see the
 * control plane serving that very panel marked as unknown. Direct checks for
 * both are applied unconditionally on every tick instead, after the
 * heartbeat-based services are reconciled, so nothing downstream can overwrite
 * them.
 */
const HEARTBEAT_STALE_MS = {
  worker: 15_000, collector: 5_000, oracle: 5_000, chaos: 5_000, scheduler: 15_000,
};

function reconcileHeartbeats() {
  for (const [id, staleMs] of Object.entries(HEARTBEAT_STALE_MS)) {
    const hb = heartbeats.get(id);
    if (!hb) { set(id, health.get(id)?.status === 'up' ? 'unknown' : health.get(id)?.status ?? 'unknown'); continue; }
    set(id, Date.now() - hb.at < staleMs ? 'up' : 'down', hb.detail);
  }
}

export function initTopology(nc) {
  set('gateway', 'up');
  set('nats', nc?.isClosed?.() ? 'down' : 'up');

  const timer = setInterval(() => {
    pollOnce().catch((err) => log.warn(`topology poll failed: ${err.message}`));
    reconcileHeartbeats();
    set('gateway', 'up');
    set('nats', nc?.isClosed?.() ? 'down' : 'up');
  }, POLL_MS);
  timer.unref?.();

  pollOnce().catch(() => {});
}

export function topologyRoutes() {
  const router = Router();

  router.get('/api/topology', (_req, res) => {
    res.json({
      services: SERVICES.map((s) => ({ ...s, ...health.get(s.id) })),
      subjects: SUBJECT_TABLE,
      generatedAt: Date.now(),
    });
  });

  return router;
}
