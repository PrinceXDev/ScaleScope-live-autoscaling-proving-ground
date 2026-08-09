/**
 * The gateway: boot sequence and wiring.
 *
 * Every other file in this service does one job -- orchestration, replay,
 * topology, or a slice of the REST surface. This file exists only to bring
 * them up in the right order and to fail loudly if any dependency the run
 * lifecycle depends on (Postgres, the event stream, the lock store) is not
 * reachable. A gateway that starts "successfully" without Valkey would accept
 * runs it cannot rate-limit, which is a worse failure than not starting.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';

import { connectBus, ensureStreams, subscribe } from '@scalescope/bus';
import { UI, TELEMETRY } from '@scalescope/contracts';
import { runPostgresMigrations, ensureClickhouse, connectValkey } from '@scalescope/stores';
import { log } from '@scalescope/telemetry';

import { initOrchestrator, HttpError } from './orchestrator.js';
import { runsRoutes } from './routes/runs.js';
import { analyticsRoutes } from './routes/analytics.js';
import { topologyRoutes, initTopology, noteHeartbeat } from './routes/topology.js';
import { streamRoutes, initStream } from './routes/stream.js';

process.env.SCALESCOPE_SERVICE = 'gateway';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo layout is apps/gateway/src/index.js -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, '../../../');
const PG_MIGRATIONS_DIR = path.join(REPO_ROOT, 'infra/migrations/postgres');
const CH_MIGRATIONS_DIR = path.join(REPO_ROOT, 'infra/migrations/clickhouse');

const PORT = Number(process.env.PORT || 3000);

/** Event name -> which heartbeat it proves is alive, for the topology panel. */
const HEARTBEAT_FROM_EVENT = {
  'suite.progress': 'scheduler',
  chaos: 'chaos',
  prediction: 'oracle',
  scaled: 'collector',
  tick: 'collector',
};

async function main() {
  log.info('booting gateway');

  // Postgres migrations run first and block startup on failure -- every other
  // step either depends on the schema existing or can tolerate a delay, but a
  // gateway that accepts a run against a schema-less database fails in the
  // worst possible way: after the credit is already spent.
  await runPostgresMigrations(PG_MIGRATIONS_DIR);
  log.info('postgres ready');

  // ClickHouse is intentionally best-effort at boot. It is very often the
  // slowest service in the project import to become reachable, and gating the
  // whole gateway on it would turn "ClickHouse is still starting" into "nothing
  // works" instead of "replay and analytics are degraded for a minute".
  try {
    await ensureClickhouse(CH_MIGRATIONS_DIR);
    log.info('clickhouse ready');
  } catch (err) {
    log.warn(`clickhouse not ready yet, continuing without it: ${err.message}`);
  }

  await connectValkey('gateway');
  log.info('valkey ready');

  const nc = await connectBus('gateway');
  const js = nc.jetstream();
  await ensureStreams(nc);
  log.info('jetstream ready');

  initOrchestrator({ nc, js });
  initStream(nc);
  initTopology(nc);

  // A second subscription to the same broadcast subject the SSE bridge already
  // listens on. This one does not touch a socket; it only proves liveness for
  // services the gateway has no other way to observe. Two listeners on one
  // PLAIN subject is exactly the fan-out this subject exists for.
  subscribe(nc, UI.BROADCAST, ({ event }) => {
    const service = HEARTBEAT_FROM_EVENT[event];
    if (service) noteHeartbeat(service);
  });
  subscribe(nc, TELEMETRY.HELLO, () => noteHeartbeat('worker'));
  subscribe(nc, TELEMETRY.WATERMARK, () => noteHeartbeat('collector'));

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'gateway' }));

  app.use(runsRoutes({ nc, js }));
  app.use(analyticsRoutes());
  app.use(topologyRoutes());
  app.use(streamRoutes({ nc, js }));

  // Centralised error translation. Route handlers throw HttpError for anything
  // a client should see a specific status for; everything else is a bug and
  // gets logged with its stack rather than leaked to the response body.
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) {
      // `extra` fields (budget, currentRunId, ...) were Object.assign'd directly
      // onto the instance in the constructor, so spreading the error itself
      // surfaces them; `message` is added explicitly because Error's own
      // `message` property is non-enumerable and a spread would otherwise drop it.
      res.status(err.status).json({ error: err.message, ...err });
      return;
    }
    log.error(`unhandled error on ${req.method} ${req.path}: ${err.stack || err.message}`);
    res.status(500).json({ error: 'internal error' });
  });

  app.listen(PORT, () => log.info(`gateway listening on ${PORT}`));
}

main().catch((err) => {
  log.error(`fatal gateway startup error: ${err.stack || err.message}`);
  process.exit(1);
});
