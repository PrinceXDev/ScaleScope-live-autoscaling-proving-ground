#!/usr/bin/env node
/**
 * `node infra/scripts/recompute-scorecards.mjs [--force]`
 *
 * Backfills `runs.scorecard` for completed runs. This is the payoff of the
 * scorecard being a pure projection of the event log rather than something
 * accumulated live: every run this platform has ever finished can be graded
 * by the same method the moment the method ships, not just runs started
 * after it. Without `--force`, only rows where `scorecard IS NULL` are
 * touched, so re-running after a partial failure is safe and cheap.
 *
 * Requires the same infrastructure the gateway needs at boot: Postgres,
 * JetStream (for the durable event log), and, best-effort, ClickHouse (for
 * the per-second timeline a few metrics depend on).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectBus, ensureStreams } from '@scalescope/bus';
import { foldRun } from '@scalescope/contracts';
import { computeScorecard, DEFAULT_CAPACITY_PER_CONTAINER } from '@scalescope/control';
import { pgPool, chJson, runPostgresMigrations, ensureClickhouse } from '@scalescope/stores';
import { log } from '@scalescope/telemetry';
// Not a package: `readRunEvents` owns real JetStream-consumer complexity
// (subject census, ephemeral pull consumer, cleanup) that belongs in one
// place. Reusing the gateway's copy beats re-deriving it for a one-off script.
import { readRunEvents } from '../../apps/gateway/src/replay.js';

process.env.SCALESCOPE_SERVICE = process.env.SCALESCOPE_SERVICE || 'gateway';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');
const PG_MIGRATIONS_DIR = path.join(REPO_ROOT, 'infra/migrations/postgres');
const CH_MIGRATIONS_DIR = path.join(REPO_ROOT, 'infra/migrations/clickhouse');

const FORCE = process.argv.includes('--force');

function hostnameFromUrl(url) {
  try {
    return new URL(String(url)).hostname || 'unknown';
  } catch {
    return 'unknown';
  }
}

function twinKey(targetHostname, rounds) {
  return `${targetHostname || 'unknown'}:${Number(rounds) || 0}`;
}

async function main() {
  await runPostgresMigrations(PG_MIGRATIONS_DIR);

  let clickhouseUp = true;
  try {
    await ensureClickhouse(CH_MIGRATIONS_DIR);
  } catch (err) {
    clickhouseUp = false;
    log.warn(`clickhouse unavailable, timeline-dependent metrics will be null: ${err.message}`);
  }

  const nc = await connectBus('gateway-script');
  await ensureStreams(nc);

  const { rows } = await pgPool.query(
    `SELECT id FROM runs WHERE status = 'completed' ${FORCE ? '' : 'AND scorecard IS NULL'} ORDER BY created_at`,
  );
  log.info(`recomputing scorecards for ${rows.length} run(s)${FORCE ? ' (--force)' : ''}`);

  let ok = 0;
  let skipped = 0;
  for (const { id: runId } of rows) {
    try {
      const events = await readRunEvents(nc, runId);
      const folded = foldRun(events.map((e) => ({ type: e.env.type, data: e.env.data, seq: e.seq })));
      if (!folded.config) { skipped += 1; continue; }

      const timelineRows = clickhouseUp
        ? await chJson('SELECT t, containers, rps, p95 FROM run_timeline WHERE run_id = :id ORDER BY t', { id: runId }).catch(() => [])
        : [];
      const timeline = timelineRows.map((r) => ({
        t: Number(r.t), containers: Number(r.containers), rps: Number(r.rps), p95: Number(r.p95),
      }));

      const twinRow = await pgPool.query('SELECT params FROM twin_params WHERE target_key = $1', [
        twinKey(hostnameFromUrl(folded.config.targetUrl), folded.config.rounds),
      ]);
      const capacityPerContainer = twinRow.rows[0]?.params?.capacityPerContainer ?? DEFAULT_CAPACITY_PER_CONTAINER;

      const scorecard = computeScorecard({
        folded,
        events: events.map((e) => ({ type: e.env.type, data: e.env.data })),
        timeline,
        capacityPerContainer,
      });

      await pgPool.query('UPDATE runs SET scorecard = $2::jsonb WHERE id = $1', [runId, JSON.stringify(scorecard)]);
      log.info(`  ${runId}: grade ${scorecard.grade ?? '—'} (composite ${scorecard.composite ?? '—'})`);
      ok += 1;
    } catch (err) {
      log.error(`  ${runId}: failed -- ${err.message}`);
    }
  }

  log.info(`done: ${ok} scored, ${skipped} skipped (no config), ${rows.length - ok - skipped} failed`);
  await nc.drain();
  await pgPool.end();
}

main().catch((err) => {
  log.error(`recompute-scorecards failed: ${err.message}`);
  process.exit(1);
});
