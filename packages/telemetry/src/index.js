/**
 * Measurement primitives shared by every service.
 *
 * The two things in here that actually matter are the aligned bucket clock and
 * the latency histogram. Everything else is convenience.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

/**
 * Read fresh on every call rather than cached at module load.
 *
 * ES module imports are fully evaluated -- this file's top level included --
 * before the importing service's own top-level statements run. Every entry
 * point sets `process.env.SCALESCOPE_SERVICE` as one of its first statements,
 * which is AFTER this module would have already captured a stale 'svc'
 * default into a top-level const. That produced exactly this bug: every log
 * line, from every service, tagged '[svc]' regardless of which service wrote
 * it -- correct-looking, quietly useless the moment two services' logs are
 * interleaved during a live demo. Reading the env var inside `emit` instead
 * costs nothing measurable and is immune to import ordering entirely.
 */
const emit = (level, ...args) => {
  if (LEVELS[level] < MIN) return;
  const service = process.env.SCALESCOPE_SERVICE || 'svc';
  const line = `[${new Date().toISOString()}] [${service}] ${level.toUpperCase()}`;
  (level === 'error' ? console.error : console.log)(line, ...args);
};

export const log = {
  debug: (...a) => emit('debug', ...a),
  info: (...a) => emit('info', ...a),
  warn: (...a) => emit('warn', ...a),
  error: (...a) => emit('error', ...a),
};

// ---------------------------------------------------------------------------
// Aligned bucket clock
// ---------------------------------------------------------------------------

/**
 * Every worker aggregates into one-second buckets. If each worker starts its
 * own setInterval whenever it happens to boot, those buckets land at arbitrary
 * offsets and summing across the fleet smears each second into its neighbours
 * -- your "requests per second" becomes an approximation and your spike edges
 * go soft.
 *
 * Instead, the gateway broadcasts a single absolute epoch T0 with the start
 * command, and every worker derives its bucket boundaries from that epoch.
 * Bucket N is [T0 + N*1000, T0 + (N+1)*1000) on every machine simultaneously,
 * so the collector's sum for bucket N is exact rather than an estimate.
 *
 * This is a small amount of code for a disproportionate amount of correctness,
 * and it is the reason the spike profile has a vertical edge on the chart
 * instead of a ramp two seconds wide.
 */
export function bucketClock(t0Ms, onBucket, intervalMs = 1000) {
  let n = Math.max(0, Math.floor((Date.now() - t0Ms) / intervalMs));
  let timer = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    const boundary = t0Ms + (n + 1) * intervalMs;
    const delay = Math.max(0, boundary - Date.now());
    timer = setTimeout(() => {
      if (stopped) return;
      const bucketIndex = n;
      n += 1;
      schedule();
      try {
        onBucket(bucketIndex, t0Ms + bucketIndex * intervalMs);
      } catch (err) {
        log.error(`bucket handler failed: ${err.message}`);
      }
    }, delay);
  };

  schedule();

  return {
    stop() { stopped = true; if (timer) clearTimeout(timer); },
    get index() { return n; },
  };
}

// ---------------------------------------------------------------------------
// Latency histogram
// ---------------------------------------------------------------------------

/**
 * A fixed-bucket log-linear histogram, deliberately chosen over keeping every
 * raw sample in an array.
 *
 * Under autopilot at high concurrency a single worker can push several
 * thousand requests a second; sorting a growing array once per tick is both
 * allocation-heavy and, more importantly, unbounded -- exactly the failure mode
 * that takes a load generator down before the thing it is testing. Bucketed
 * counts are constant-memory and constant-time, and the precision loss at the
 * millisecond scale we care about is irrelevant.
 *
 * Buckets: 1ms resolution to 100ms, 5ms to 1s, 50ms to 10s, then overflow.
 */
export class LatencyHistogram {
  constructor() {
    this.counts = new Uint32Array(100 + 180 + 180 + 1);
    this.total = 0;
    this.sum = 0;
    this.max = 0;
  }

  static bucketFor(ms) {
    if (ms < 100) return Math.max(0, Math.floor(ms));
    if (ms < 1000) return 100 + Math.floor((ms - 100) / 5);
    if (ms < 10000) return 280 + Math.floor((ms - 1000) / 50);
    return 460;
  }

  static valueOf(bucket) {
    if (bucket < 100) return bucket;
    if (bucket < 280) return 100 + (bucket - 100) * 5;
    if (bucket < 460) return 1000 + (bucket - 280) * 50;
    return 10000;
  }

  record(ms) {
    this.counts[LatencyHistogram.bucketFor(ms)] += 1;
    this.total += 1;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }

  percentile(p) {
    if (this.total === 0) return 0;
    const want = Math.ceil(this.total * p);
    let seen = 0;
    for (let i = 0; i < this.counts.length; i += 1) {
      seen += this.counts[i];
      if (seen >= want) return LatencyHistogram.valueOf(i);
    }
    return this.max;
  }

  get mean() { return this.total ? this.sum / this.total : 0; }

  reset() {
    this.counts.fill(0);
    this.total = 0;
    this.sum = 0;
    this.max = 0;
  }

  snapshot() {
    return {
      count: this.total,
      p50: Math.round(this.percentile(0.5)),
      p95: Math.round(this.percentile(0.95)),
      p99: Math.round(this.percentile(0.99)),
      mean: Math.round(this.mean),
      max: Math.round(this.max),
    };
  }
}

// ---------------------------------------------------------------------------
// Rolling instance window
// ---------------------------------------------------------------------------

/**
 * Container presence, measured rather than reported.
 *
 * A cumulative Set of instance ids answers "which containers ever existed",
 * which is not the question. Holding last-seen timestamps and expiring beyond
 * a window answers "which containers are serving right now", which is, and it
 * is the only reason the scale-down half of the curve is observable at all.
 */
export class InstanceWindow {
  constructor(windowMs = 10_000) {
    this.windowMs = windowMs;
    this.seen = new Map();   // id -> lastSeenMs
    this.born = new Map();   // id -> firstSeenMs
  }

  observe(id, atMs = Date.now()) {
    if (!this.born.has(id)) this.born.set(id, atMs);
    this.seen.set(id, atMs);
  }

  prune(nowMs = Date.now()) {
    for (const [id, t] of this.seen) {
      if (nowMs - t > this.windowMs) this.seen.delete(id);
    }
  }

  count(nowMs = Date.now()) {
    this.prune(nowMs);
    return this.seen.size;
  }

  /** Lifetimes for the container swimlane, reconstructed from headers alone. */
  lifetimes() {
    return [...this.born.entries()].map(([id, from]) => ({
      id, from, to: this.seen.get(id) ?? from, alive: this.seen.has(id),
    }));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
