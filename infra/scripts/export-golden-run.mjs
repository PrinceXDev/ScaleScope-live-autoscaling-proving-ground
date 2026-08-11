#!/usr/bin/env node
/**
 * `node infra/scripts/export-golden-run.mjs <runId>`
 *
 * Freezes one real run's durable event log into a static JSON fixture at
 * `apps/web/public/golden-run.json` -- the file the "golden run" attract-mode
 * fallback replays entirely client-side, with no gateway, no NATS, no
 * Postgres and no ClickHouse involved at view time. See
 * `apps/web/src/lib/goldenReplay.js` for the player and `docs/features.md`
 * for why this exists: judging is asynchronous, and a link that only tells
 * the story while every backing service is warm is a worse bet than one that
 * tells it from a static file forever.
 *
 * The fixture strips each envelope down to exactly what the player needs --
 * `{ type, data, emittedAt }` -- dropping `v`, `runId`, `producer`, and the
 * JetStream `seq`/`subject` wrapper, none of which the pacing algorithm or
 * the SSE-name lookup ever reads (see `replayRun` in
 * `apps/gateway/src/replay.js`, which this player's pacing loop mirrors
 * exactly so the two stay provably in sync).
 *
 * Run this once, by hand, against your best recorded run, and commit the
 * resulting JSON -- it is a deliberate snapshot, not something regenerated
 * on every deploy.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

import { connectBus } from '@scalescope/bus';
import { pgPool } from '@scalescope/stores';
import { log } from '@scalescope/telemetry';
// Same justification as infra/scripts/recompute-scorecards.mjs: readRunEvents
// owns real JetStream-consumer complexity that belongs in exactly one place.
import { readRunEvents } from '../../apps/gateway/src/replay.js';

process.env.SCALESCOPE_SERVICE = process.env.SCALESCOPE_SERVICE || 'gateway';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, '../../apps/web/public/golden-run.json');

const runId = process.argv[2];
if (!runId) {
  console.error('usage: node infra/scripts/export-golden-run.mjs <runId>');
  process.exit(1);
}

async function main() {
  const { rows } = await pgPool.query(
    `SELECT id, name, profile, peak_containers, peak_rps, peak_p95_ms,
            time_to_recover_s, total_requests, est_cost_usd, scorecard, created_at
     FROM runs WHERE id = $1 AND status = 'completed'`,
    [runId],
  );
  const run = rows[0];
  if (!run) {
    console.error(`no completed run found with id ${runId}`);
    process.exit(1);
  }

  const nc = await connectBus('gateway-script');
  const events = await readRunEvents(nc, runId);
  await nc.drain();
  await pgPool.end();

  if (events.length === 0) {
    console.error(`run ${runId} has no event log in JetStream (aged out, or was replayed-from-timeline itself)`);
    process.exit(1);
  }

  const fixture = {
    v: 1,
    recordedAt: new Date().toISOString(),
    run: {
      id: run.id,
      name: run.name,
      profile: run.profile,
      peakContainers: run.peak_containers,
      peakRps: run.peak_rps,
      peakP95Ms: run.peak_p95_ms,
      timeToRecoverS: run.time_to_recover_s,
      totalRequests: Number(run.total_requests),
      estCostUsd: run.est_cost_usd == null ? null : Number(run.est_cost_usd),
      grade: run.scorecard?.grade ?? null,
    },
    events: events.map(({ env }) => ({ type: env.type, data: env.data, emittedAt: env.emittedAt })),
  };

  await writeFile(OUT_PATH, JSON.stringify(fixture), 'utf8');
  log.info(`wrote ${events.length} events (${(JSON.stringify(fixture).length / 1024).toFixed(0)}kb) to ${OUT_PATH}`);
}

main().catch((err) => {
  log.error(`export-golden-run failed: ${err.message}`);
  process.exit(1);
});
