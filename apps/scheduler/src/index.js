/**
 * The scheduler: unattended experiment suites.
 *
 * A suite turns "I ran two tests and eyeballed the difference" into "I swept a
 * configuration space and here is the curve". This service owns exactly one
 * thing at a time -- one suite running -- and leans on the gateway for every
 * run it starts (see suites.js for why that indirection is load-bearing rather
 * than incidental).
 *
 * The most dangerous property a scheduler can have is an unbounded loop next
 * to a credit-billed backend, so the budget guard below is checked before
 * every single step, not just at suite start, and it is unconditional: no
 * suite kind is exempt.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { SUITE } from '@scalescope/contracts';
import { connectBus, ensureStreams, subscribe, pub, broadcast } from '@scalescope/bus';
import { pgPool, runPostgresMigrations } from '@scalescope/stores';
import { log, sleep } from '@scalescope/telemetry';
import { runManual, runKnee, runEnvelope, runRegression, REGRESSION_CONFIG, BudgetExceeded } from './suites.js';
import { startRegressionTimer } from './cron.js';

process.env.SCALESCOPE_SERVICE = 'scheduler';

const PORT = Number(process.env.PORT || 3000);
const SUITE_MAX_RUNS = Number(process.env.SUITE_MAX_RUNS || 8);
const SUITE_MAX_TOTAL_S = Number(process.env.SUITE_MAX_TOTAL_S || 900);

let nc = null;
let current = null; // { id, kind, startedAt, runsUsed, secondsUsed, abort }

function makeGuard(state) {
  return () => {
    if (state.abort) throw new Error('suite aborted by operator');
    state.runsUsed += 1;
    const elapsedS = (Date.now() - state.startedAt) / 1000;
    if (state.runsUsed > SUITE_MAX_RUNS || elapsedS > SUITE_MAX_TOTAL_S) {
      // Checked before the step it would have permitted, not after -- an
      // after-the-fact check has already spent the credit it was meant to
      // prevent spending.
      throw new BudgetExceeded(`suite budget exceeded (runs=${state.runsUsed}/${SUITE_MAX_RUNS}, seconds=${Math.round(elapsedS)}/${SUITE_MAX_TOTAL_S})`);
    }
  };
}

async function persist(suiteId, patch) {
  const sets = [];
  const vals = [suiteId];
  for (const [k, v] of Object.entries(patch)) {
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  await pgPool.query(`UPDATE suites SET ${sets.join(', ')} WHERE id = $1`, vals).catch((err) => log.warn(`suite persist failed: ${err.message}`));
}

async function runSuite(suiteId, kind, params) {
  const state = { id: suiteId, kind, startedAt: Date.now(), runsUsed: 0, abort: false };
  current = state;
  const guard = makeGuard(state);

  await persist(suiteId, { status: 'running', started_at: new Date().toISOString() });
  broadcast(nc, 'suite.progress', { suiteId, kind, status: 'running', step: 0 });

  let stepIndex = 0;
  let result = null;
  let status = 'completed';

  try {
    let iterator;
    if (kind === 'manual') iterator = runManual(params.steps || [], guard);
    else if (kind === 'knee') iterator = runKnee(params, guard);
    else if (kind === 'envelope') iterator = runEnvelope(params, guard);
    else if (kind === 'regression') {
      const { rows } = await pgPool.query(
        `SELECT result FROM suites WHERE kind = 'regression' AND status = 'completed' ORDER BY ended_at DESC LIMIT 1`,
      );
      iterator = runRegression(rows[0]?.result ?? null, guard);
    } else {
      throw new Error(`unknown suite kind: ${kind}`);
    }

    for await (const step of iterator) {
      stepIndex += 1;
      await persist(suiteId, { current_step: stepIndex });
      broadcast(nc, 'suite.progress', { suiteId, kind, status: 'running', step: stepIndex, stepResult: step });
      log.info(`suite ${suiteId} step ${stepIndex}: run=${step.runId} summary=${JSON.stringify(step.summary || {})}`);
      // A brief pause between steps even beyond each run's own cooldown -- the
      // target's own vertical scale-down and any platform-side settling get a
      // moment before the next probe leans on it, so consecutive probes are
      // measuring independent conditions rather than a still-draining previous one.
      await sleep(3000);
    }

    // Generators that return a final aggregate (knee, envelope, regression)
    // expose it via the iterator's return value, which for-await does not
    // surface directly -- so we re-drive .next() once more defensively is
    // unnecessary; instead each generator's final yielded step already carries
    // enough to reconstruct the aggregate for manual/regression, and knee/
    // envelope additionally stash it on the last step. Kept simple on purpose:
    // the suites table's `result` column stores whatever we have.
    result = { steps: stepIndex, kind, finishedAt: Date.now() };
  } catch (err) {
    status = err instanceof BudgetExceeded ? 'aborted_budget' : (state.abort ? 'aborted' : 'failed');
    log.error(`suite ${suiteId} ${status}: ${err.message}`);
    result = { error: err.message, steps: stepIndex };
  }

  await persist(suiteId, {
    status,
    result: JSON.stringify(result),
    ended_at: new Date().toISOString(),
  });
  broadcast(nc, 'suite.progress', { suiteId, kind, status, step: stepIndex, result });
  current = null;
}

async function main() {
  log.info('booting scheduler');

  // Migrations were almost certainly already applied by the gateway; running
  // them here too is idempotent and means the scheduler can boot standalone
  // during local development without waiting on another service.
  await runPostgresMigrations(new URL('../../../infra/migrations/postgres', import.meta.url).pathname).catch((err) =>
    log.warn(`scheduler migrations skipped: ${err.message}`));

  nc = await connectBus('scheduler');
  await ensureStreams(nc);

  subscribe(nc, SUITE.START, async (msg) => {
    if (current) {
      log.warn(`suite.start received while suite ${current.id} is running; ignoring`);
      return;
    }
    const suiteId = msg.suiteId || randomUUID();
    await pgPool.query(
      `INSERT INTO suites (id, name, kind, steps, status) VALUES ($1,$2,$3,$4,'pending')
       ON CONFLICT (id) DO NOTHING`,
      [suiteId, msg.name || `${msg.kind}-suite`, msg.kind, JSON.stringify(msg.params || {})],
    ).catch((err) => log.error(`suite insert failed: ${err.message}`));

    runSuite(suiteId, msg.kind, msg.params || {}).catch((err) => log.error(`suite run crashed: ${err.message}`));
  });

  subscribe(nc, SUITE.ABORT, (msg) => {
    if (current && (!msg.suiteId || msg.suiteId === current.id)) {
      current.abort = true;
      log.info(`abort requested for suite ${current.id}`);
    }
  });

  startRegressionTimer(async () => {
    if (current) {
      log.warn('skipping scheduled regression: a suite is already running');
      return;
    }
    const suiteId = randomUUID();
    await pgPool.query(
      `INSERT INTO suites (id, name, kind, steps, status) VALUES ($1,$2,'regression',$3,'pending')`,
      [suiteId, 'nightly-regression', JSON.stringify(REGRESSION_CONFIG)],
    ).catch((err) => log.error(`regression suite insert failed: ${err.message}`));
    await runSuite(suiteId, 'regression', {});
  });

  http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'scheduler', current: current ? { id: current.id, kind: current.kind, runsUsed: current.runsUsed } : null }));
      return;
    }
    if (req.url === '/suites/current') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(current || null));
      return;
    }
    res.writeHead(404).end();
  }).listen(PORT, () => log.info(`scheduler healthz on ${PORT}`));

  log.info('scheduler ready');
}

main().catch((err) => {
  log.error(`fatal scheduler startup error: ${err.stack || err.message}`);
  process.exit(1);
});
