/**
 * Pure projection logic: bucketing, watermarking, and the two small state
 * machines (scale-change, SLO breach/recovery) that turn a stream of merged
 * frames into annotations.
 *
 * Deliberately free of NATS, HTTP, and Postgres/ClickHouse clients. A watermark
 * policy or an SLO debounce rule is exactly the kind of logic that is easy to
 * get subtly wrong under time pressure, and the only way to catch that quickly
 * is to be able to call the function directly with a plain array and see what
 * comes out -- which is impossible if it is welded to a live NATS subscription.
 */

import { UNKNOWN_INSTANCE } from '@scalescope/contracts';

/**
 * How long after the newest bucket's boundary we wait before flushing an older
 * bucket. This is a watermark, not a fixed per-tick timer, and the difference
 * matters: workers are independent processes on independent containers, and a
 * fixed "flush 1000ms after bucket N opens" timer assumes every worker's sample
 * for bucket N has arrived by then, which clock skew and scheduling jitter make
 * a bad assumption under load. Waiting for the *next* bucket to be 1.5s old
 * instead tolerates a worker that is briefly behind without holding every
 * bucket open indefinitely.
 */
export const WATERMARK_LAG_MS = 1500;

/** Key a sample or frame belongs to a single (run, second) bucket. */
export const bucketKey = (runId, t) => `${runId}:${t}`;

/**
 * A bounded, insertion-ordered accumulator of in-flight buckets.
 *
 * Insertion order matters here: `flushable()` below relies on the oldest bucket
 * being the first entry, which is true only because JS Maps preserve insertion
 * order and we always add strictly increasing (runId, t) keys as they arrive.
 */
export class BucketAccumulator {
  constructor() {
    /** key -> { runId, t, samples: [], firstSeenAtMs } */
    this.buckets = new Map();
    this.newestBoundaryMs = 0;
  }

  add(sample, wallMs = Date.now()) {
    const key = bucketKey(sample.runId, sample.t);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { runId: sample.runId, t: sample.t, samples: [], firstSeenAtMs: wallMs };
      this.buckets.set(key, bucket);
    }
    bucket.samples.push(sample);
    // wallMs on the sample is the bucket's own boundary, broadcast from the
    // shared T0 -- using it rather than local receive time is what keeps the
    // watermark correct even if the collector's clock is skewed from the fleet.
    if (sample.wallMs > this.newestBoundaryMs) this.newestBoundaryMs = sample.wallMs;
  }

  /**
   * Buckets old enough that we are willing to consider them complete. Returns
   * them in the order they should be flushed (oldest first), removing them from
   * the accumulator.
   */
  drainFlushable(lagMs = WATERMARK_LAG_MS) {
    const out = [];
    for (const [key, bucket] of this.buckets) {
      const boundary = bucket.samples[0]?.wallMs ?? 0;
      if (this.newestBoundaryMs - boundary >= lagMs) {
        this.buckets.delete(key);
        out.push(bucket);
      }
    }
    return out;
  }

  /** Force-flush everything, used when a run's STOP/COMPLETED arrives. */
  drainAll(runId) {
    const out = [];
    for (const [key, bucket] of this.buckets) {
      if (bucket.runId !== runId) continue;
      this.buckets.delete(key);
      out.push(bucket);
    }
    return out;
  }

  get pendingCount() {
    return this.buckets.size;
  }
}

/**
 * Scale-change detection: compare consecutive containers counts for a run and
 * emit a `{ from, to }` transition the first time a new count is observed. A
 * naive "count != lastCount" check would fire on every tick where the count
 * merely holds steady at a non-initial value if the caller re-checks against
 * a stale `lastCount`; keeping the state here as a small class removes that
 * class of bug by construction -- there is exactly one place `lastCount` is
 * read and written.
 */
export class ScaleTracker {
  constructor() {
    /** runId -> last observed container count */
    this.last = new Map();
  }

  /** @returns {{from:number, to:number}|null} */
  observe(runId, containers) {
    const prev = this.last.get(runId);
    this.last.set(runId, containers);
    if (prev === undefined || prev === containers) return null;
    return { from: prev, to: containers };
  }

  clear(runId) {
    this.last.delete(runId);
  }
}

/**
 * SLO breach/recovery state machine.
 *
 * A single tick over the threshold is not a breach worth annotating -- latency
 * is noisy second to second, and marking every jitter spike as an SLO event
 * would bury the real ones. A breach is declared once and stays declared until
 * `recoverTicks` consecutive ticks are back under threshold, which is also what
 * makes "time to recover" a meaningful number rather than the time to the first
 * lucky tick.
 */
export class SloTracker {
  constructor(recoverTicks = 5) {
    this.recoverTicks = recoverTicks;
    /** runId -> { breached: bool, breachT: number|null, goodStreak: number } */
    this.state = new Map();
  }

  /** @returns {{state:'breached'|'recovered', t:number, timeToRecoverS?:number}|null} */
  observe(runId, t, p95, thresholdMs) {
    let s = this.state.get(runId);
    if (!s) {
      s = { breached: false, breachT: null, goodStreak: 0 };
      this.state.set(runId, s);
    }

    const over = p95 > thresholdMs;

    if (!s.breached) {
      if (over) {
        s.breached = true;
        s.breachT = t;
        s.goodStreak = 0;
        return { state: 'breached', t };
      }
      return null;
    }

    // Already breached: count consecutive healthy ticks before declaring recovery.
    if (over) {
      s.goodStreak = 0;
      return null;
    }
    s.goodStreak += 1;
    if (s.goodStreak >= this.recoverTicks) {
      const timeToRecoverS = t - s.breachT;
      s.breached = false;
      s.breachT = null;
      s.goodStreak = 0;
      return { state: 'recovered', t, timeToRecoverS };
    }
    return null;
  }

  clear(runId) {
    this.state.delete(runId);
  }
}

/** True once a run's most recent samples are all cooldown-phase, used to fire EVENT.PHASE exactly once. */
export class PhaseTracker {
  constructor() {
    /** runId -> last phase seen */
    this.last = new Map();
  }

  /** @returns {string|null} the new phase if it changed, else null */
  observe(runId, phase) {
    const prev = this.last.get(runId);
    this.last.set(runId, phase);
    return prev !== undefined && prev !== phase ? phase : null;
  }

  clear(runId) {
    this.last.delete(runId);
  }
}

/** Count of real (non-synthetic) instances in a merged frame's instance list. */
export const realInstanceCount = (instances) =>
  instances.filter((i) => i.id !== UNKNOWN_INSTANCE).length;
