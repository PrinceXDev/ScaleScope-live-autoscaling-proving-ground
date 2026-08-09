/**
 * Analytical read paths. Everything here reads the ClickHouse projection, never
 * the event log -- the log is optimised for ordered replay of one run, and
 * asking it "what did every run look like" would mean folding megabytes to
 * answer a question a columnar store answers by scanning two columns.
 */

import { Router } from 'express';
import { CreditBudget, chJson, pgPool } from '@scalescope/stores';
import { log } from '@scalescope/telemetry';
import { MAX_RUNS_PER_HOUR } from '../orchestrator.js';
import { requireUuid } from './runs.js';

/** Fields whose difference between two runs is worth showing in a comparison. */
const COMPARED_FIELDS = [
  'profile', 'rounds', 'max_concurrency', 'duration_s', 'cooldown_s',
  'slo_p95_ms', 'setpoint_ms', 'target_url',
];

export function analyticsRoutes() {
  const router = Router();

  /**
   * The run timeline: one row per second, containers counted by distinct
   * observed instance. This is the query the whole product is built around, and
   * it lives in a ClickHouse view (`run_timeline`) rather than being assembled
   * here, so that the live path and the replay path cannot drift apart in how
   * they define "containers during second N".
   */
  router.get('/api/runs/:id/timeline', requireUuid, async (req, res, next) => {
    try {
      const rows = await chJson(
        'SELECT * FROM run_timeline WHERE run_id = :id ORDER BY t',
        { id: req.params.id },
      );
      res.json(rows.map(coerceTimelineRow));
    } catch (err) { next(err); }
  });

  /**
   * Per-container attribution. Powers the lifecycle swimlane, and answers a
   * question a bare container count cannot: did the container the platform added
   * actually take traffic? A container that boots but receives no requests looks
   * identical on a count chart and is a completely different situation.
   */
  router.get('/api/runs/:id/instances', requireUuid, async (req, res, next) => {
    try {
      const [observed, recorded] = await Promise.all([
        chJson(
          `SELECT target_instance, first_t, last_t, requests, peak_p95, max_age_ms
           FROM run_instances WHERE run_id = :id ORDER BY first_t`,
          { id: req.params.id },
        ),
        pgPool.query(
          `SELECT instance_id, first_seen_ms, last_seen_ms, boot_ms, requests, peak_p95_ms
           FROM instances WHERE run_id = $1`,
          [req.params.id],
        ),
      ]);

      const byId = new Map(recorded.rows.map((r) => [r.instance_id, r]));
      res.json(observed.map((o) => ({
        id: o.target_instance,
        firstT: Number(o.first_t),
        lastT: Number(o.last_t),
        requests: Number(o.requests),
        peakP95: Number(o.peak_p95),
        maxAgeMs: Number(o.max_age_ms),
        // A container whose maximum observed age is smaller than the elapsed
        // run is one that booted during the run -- which is precisely what
        // "the platform scaled up" looks like from the outside.
        bornDuringRun: Number(o.max_age_ms) < (Number(o.last_t) * 1000),
        firstSeenMs: byId.get(o.target_instance)?.first_seen_ms ?? null,
      })));
    } catch (err) { next(err); }
  });

  /**
   * A/B comparison. Returns both timelines, both summaries, and an explicit
   * config diff, because "these two runs differ" is only useful alongside "and
   * here is the single knob that differed".
   */
  router.get('/api/compare', async (req, res, next) => {
    try {
      const { a, b } = req.query;
      if (!a || !b) return res.status(400).json({ error: 'both a and b run ids are required' });

      const { rows } = await pgPool.query('SELECT * FROM runs WHERE id = ANY($1::uuid[])', [[a, b]]);
      const runA = rows.find((r) => r.id === a);
      const runB = rows.find((r) => r.id === b);
      if (!runA || !runB) return res.status(404).json({ error: 'run not found' });

      const [timelineA, timelineB] = await Promise.all([
        chJson('SELECT * FROM run_timeline WHERE run_id = :id ORDER BY t', { id: a }),
        chJson('SELECT * FROM run_timeline WHERE run_id = :id ORDER BY t', { id: b }),
      ]);

      const diff = COMPARED_FIELDS
        .filter((f) => String(runA[f]) !== String(runB[f]))
        .map((f) => ({ field: f, a: runA[f], b: runB[f] }));

      res.json({
        a: { run: runA, timeline: timelineA.map(coerceTimelineRow) },
        b: { run: runB, timeline: timelineB.map(coerceTimelineRow) },
        diff,
        deltas: {
          peakContainers: num(runB.peak_containers) - num(runA.peak_containers),
          peakRps: num(runB.peak_rps) - num(runA.peak_rps),
          peakP95Ms: num(runB.peak_p95_ms) - num(runA.peak_p95_ms),
          timeToRecoverS: num(runB.time_to_recover_s) - num(runA.time_to_recover_s),
          estCostUsd: num(runB.est_cost_usd) - num(runA.est_cost_usd),
        },
      });
    } catch (err) { next(err); }
  });

  /** Latest completed capacity-envelope sweep, produced by the scheduler. */
  router.get('/api/envelope', async (_req, res, next) => {
    try {
      const { rows } = await pgPool.query(
        `SELECT id, name, result, ended_at FROM suites
         WHERE kind IN ('envelope','knee') AND status = 'completed' AND result IS NOT NULL
         ORDER BY ended_at DESC LIMIT 1`,
      );
      res.json(rows[0] || null);
    } catch (err) { next(err); }
  });

  /**
   * Remaining run budget for the current hour.
   *
   * Surfaced to the UI deliberately rather than kept as a silent server-side
   * guard. A public start button on a credit-billed backend needs a ceiling, and
   * showing the ceiling turns it from an unexplained 429 into an understood
   * constraint.
   */
  router.get('/api/budget', async (_req, res, next) => {
    try {
      res.json(await CreditBudget.peek(MAX_RUNS_PER_HOUR));
    } catch (err) {
      // Valkey being unreachable must not take the dashboard down; the budget
      // widget simply disappears.
      log.warn(`budget peek failed: ${err.message}`);
      res.json({ used: 0, limit: MAX_RUNS_PER_HOUR, remaining: MAX_RUNS_PER_HOUR, degraded: true });
    }
  });

  return router;
}

const num = (v) => (v == null ? 0 : Number(v));

/**
 * ClickHouse returns 64-bit integers as strings over JSON, because they do not
 * survive a double. Every one of these fits comfortably in a double at our
 * volumes, so coercing here keeps the frontend free of string-vs-number
 * arithmetic bugs -- of which "rps: '12' + '15' = '1215'" is the classic.
 */
function coerceTimelineRow(r) {
  return {
    runId: r.run_id,
    t: Number(r.t),
    phase: r.phase,
    rps: Number(r.rps),
    errors: Number(r.errors),
    p50: Number(r.p50),
    p95: Number(r.p95),
    p99: Number(r.p99),
    containers: Number(r.containers),
    workers: Number(r.workers),
    concurrency: Number(r.concurrency),
    setpointMs: r.setpoint_ms == null ? null : Number(r.setpoint_ms),
  };
}
