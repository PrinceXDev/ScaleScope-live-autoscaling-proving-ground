/**
 * Twin persistence: the difference between a model and a guess.
 *
 * `AutoscalerTwin` is pure and in-memory by design -- it has no idea a database
 * exists, which is what makes it unit-testable in milliseconds. This module is
 * the only place that knows the twin's parameters have a home in Postgres, and
 * it deliberately stays that thin.
 *
 * Everything here degrades rather than throws. The oracle is a passenger on the
 * schema, not its owner: the gateway runs the migrations, so on a cold project
 * the oracle can legitimately boot before `twin_params` exists. When that
 * happens the right behaviour is to run from priors and say so once in the log,
 * not to crash-loop a container whose actual job -- forecasting -- works fine
 * without any history at all.
 */

import { pgPool } from '@scalescope/stores';
import { log } from '@scalescope/telemetry';
import { DEFAULT_RUN } from '@scalescope/contracts';

/** Postgres' "undefined_table". The one error we treat as a warning. */
const UNDEFINED_TABLE = '42P01';

let schemaWarned = false;

/**
 * Every query in this file funnels through here so that a missing schema or an
 * unconfigured database produces `fallback` exactly once in the log rather than
 * an error per tick. At one prediction per second per run, a chatty failure
 * path would bury every other line in the log within a minute.
 */
async function query(sql, params, fallback) {
  if (!pgPool) {
    if (!schemaWarned) {
      schemaWarned = true;
      log.warn('postgres not configured; twin runs from priors and learns nothing across restarts');
    }
    return fallback;
  }
  try {
    return await pgPool.query(sql, params);
  } catch (err) {
    if (err.code === UNDEFINED_TABLE) {
      if (!schemaWarned) {
        schemaWarned = true;
        log.warn('twin_params missing (gateway owns migrations); running from priors until it appears');
      }
      return fallback;
    }
    log.error(`twin persistence query failed: ${err.message}`);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Keying
// ---------------------------------------------------------------------------

/**
 * The identity of a trained model.
 *
 * `capacityPerContainer` is the parameter everything else in the twin hangs
 * off, and it is only meaningful at a fixed `rounds` setting, because `rounds`
 * *is* the per-request cost -- it is the number of hash iterations the target
 * burns before replying. A twin trained at 12000 rounds has learned "one
 * container sustains roughly N requests per second where each request costs
 * 12000 rounds". Feed it a 40000-round run and that number is not merely
 * imprecise, it is describing a different machine. Keying on
 * `${targetHostname}:${rounds}` keeps those populations apart, at the cost of
 * needing more runs before any one key is well-fitted. That trade is correct:
 * a confidently wrong model is worse than an honestly cold one, and the twin
 * reports its own confidence, so a cold key is visible rather than silent.
 *
 * The hostname is in the key for the same reason -- point ScaleScope at a
 * different target service and none of the learned lags transfer.
 */
export function twinKey(targetHostname, rounds) {
  return `${targetHostname || 'unknown'}:${Number(rounds) || DEFAULT_RUN.rounds}`;
}

/** Hostname only. The path and port are irrelevant to what the twin learned. */
export function hostnameFromUrl(url) {
  try {
    return new URL(String(url)).hostname || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Run config lookup
// ---------------------------------------------------------------------------

/**
 * A TickFrame carries no configuration -- it is the rendering primitive, and
 * bloating it with the run's config would put the same immutable payload on the
 * wire once per second for the life of every run. So the oracle reads the two
 * fields it needs straight from the write model.
 *
 * Reading Postgres directly rather than calling the gateway is the right call
 * here specifically because this is a *read* of frozen config. The argument for
 * routing writes through the gateway (it owns the run lock, the credit budget
 * and the start barrier) has no read-side equivalent: there is no invariant to
 * violate, and adding an HTTP hop would make the oracle fail when the gateway
 * is redeploying, for no gain.
 */
export async function lookupRunConfig(runId) {
  const res = await query(
    'SELECT target_url, rounds, max_concurrency, slo_p95_ms FROM runs WHERE id = $1',
    [runId],
    null,
  );
  const row = res?.rows?.[0];
  if (!row) return null;
  return {
    targetUrl: row.target_url,
    rounds: row.rounds,
    maxConcurrency: row.max_concurrency,
    sloP95Ms: row.slo_p95_ms,
  };
}

// ---------------------------------------------------------------------------
// Parameter load / save
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<null|{params: object, samples: number, meanAbsErr: number|null, updatedAt: string}>}
 */
export async function loadTwinParams(key) {
  const res = await query(
    'SELECT params, samples, mean_abs_err, updated_at FROM twin_params WHERE target_key = $1',
    [key],
    null,
  );
  const row = res?.rows?.[0];
  if (!row) return null;
  return {
    targetKey: key,
    params: row.params || {},
    samples: row.samples ?? 0,
    meanAbsErr: row.mean_abs_err,
    updatedAt: row.updated_at,
  };
}

/** Everything the dashboard needs to render "what the model currently believes". */
export async function listTwinParams(limit = 50) {
  const res = await query(
    'SELECT target_key, params, samples, mean_abs_err, updated_at FROM twin_params ORDER BY updated_at DESC LIMIT $1',
    [limit],
    null,
  );
  return (res?.rows || []).map((r) => ({
    targetKey: r.target_key,
    params: r.params || {},
    samples: r.samples ?? 0,
    meanAbsErr: r.mean_abs_err,
    updatedAt: r.updated_at,
  }));
}

/**
 * Write the learned parameters back.
 *
 * This UPSERT is the whole reason the twin is interesting rather than a toy.
 * Without it every container restart resets the model to its priors, and the
 * forecast you show a judge is always the forecast of a system that has never
 * seen this platform before. With it, knowledge accumulates: the first run of
 * the day starts cold and the tenth starts from nine runs of fitted lag, and
 * that progression -- visible as `samples` climbing while `mean_abs_err` falls
 * -- is itself one of the more honest things this project can put on screen.
 * "Here is the model getting better" beats any single accuracy number.
 *
 * `mean_abs_err` is blended rather than averaged over all history. A true
 * running mean would be permanently weighed down by the cold early runs, which
 * would misrepresent the model as it stands today; the exponential blend
 * answers "how wrong is this model *now*", which is the question the number is
 * being asked. `samples` stays a true count, because that one really is
 * cumulative and it is what tells you how much to trust the rest.
 */
export async function saveTwinParams(key, params, meanAbsErr) {
  const res = await query(
    `INSERT INTO twin_params (target_key, params, samples, mean_abs_err, updated_at)
          VALUES ($1, $2::jsonb, 1, $3, now())
     ON CONFLICT (target_key) DO UPDATE SET
          params       = EXCLUDED.params,
          samples      = twin_params.samples + 1,
          mean_abs_err = CASE
                           WHEN EXCLUDED.mean_abs_err IS NULL THEN twin_params.mean_abs_err
                           WHEN twin_params.mean_abs_err IS NULL THEN EXCLUDED.mean_abs_err
                           ELSE twin_params.mean_abs_err * 0.7 + EXCLUDED.mean_abs_err * 0.3
                         END,
          updated_at   = now()
     RETURNING samples, mean_abs_err`,
    [key, JSON.stringify(params), meanAbsErr ?? null],
    null,
  );
  const row = res?.rows?.[0];
  return row ? { samples: row.samples, meanAbsErr: row.mean_abs_err } : null;
}

// ---------------------------------------------------------------------------
// Rolling accuracy log
// ---------------------------------------------------------------------------

/**
 * Prediction-versus-actual pairs, in memory, capped.
 *
 * Deliberately not persisted. Every pair in here is derivable from data that is
 * already durable -- PREDICTION events and TICK events sit in the same
 * JetStream log, keyed by run and timestamp -- so writing a second copy to
 * Postgres would be storing a projection we can always rebuild, and paying for
 * it on the hot path at one insert per second per run.
 *
 * What this buys instead is a cheap `/accuracy` endpoint the dashboard can poll
 * to plot forecast error over time, and the cap means an oracle left running
 * for a week has exactly the same memory profile as one that just booted.
 */
export class AccuracyLog {
  constructor(cap = Number(process.env.ORACLE_ACCURACY_LOG || 500)) {
    this.cap = Math.max(50, cap);
    this.entries = [];
  }

  /**
   * @param {{runId:string, targetKey:string, t:number, predictedAtT:number,
   *          horizonS:number, predicted:number, actual:number}} pair
   */
  record(pair) {
    const absError = Math.abs(pair.predicted - pair.actual);
    this.entries.push({ ...pair, absError, at: Date.now() });
    if (this.entries.length > this.cap) this.entries.shift();
    return absError;
  }

  /** Newest first, because that is the order every consumer wants it in. */
  recent(limit = 200, runId = null) {
    const rows = runId ? this.entries.filter((e) => e.runId === runId) : this.entries;
    return rows.slice(-limit).reverse();
  }

  /** Mean absolute error across the window, in containers. */
  meanAbsError(runId = null) {
    const rows = runId ? this.entries.filter((e) => e.runId === runId) : this.entries;
    if (!rows.length) return null;
    return rows.reduce((a, e) => a + e.absError, 0) / rows.length;
  }

  /**
   * Fraction of forecasts that landed on the exact container count. Container
   * counts are small integers, so "within 0" is a meaningful and unusually
   * legible accuracy statistic -- much more so than an R-squared on a series
   * that only ever takes six values.
   */
  exactRate(runId = null) {
    const rows = runId ? this.entries.filter((e) => e.runId === runId) : this.entries;
    if (!rows.length) return null;
    return rows.filter((e) => e.absError < 0.5).length / rows.length;
  }
}
