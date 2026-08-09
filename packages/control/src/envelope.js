/**
 * Capacity envelope solver.
 *
 * A single run tells you what happened at one load. The envelope tells you the
 * shape of the whole system: for each container count the platform is willing
 * to give you, what is the maximum sustainable throughput at your SLO, and at
 * what cost per million requests?
 *
 * The solver drives short probes rather than one long run. Each probe holds the
 * autopilot at a latency setpoint until the controller settles, records the
 * throughput and container count it settled at, and stops. Probes are cheap
 * (fifteen to twenty seconds) and a full sweep is comparable in credit cost to
 * two normal runs, which matters on a fixed budget.
 *
 * The interesting output is the *knee*: the concurrency at which the first
 * container is added. Ternary search finds it in far fewer probes than a linear
 * sweep, which is the whole reason for the search rather than just running
 * every value.
 */

export const PROBE = {
  DURATION_S: 18,
  SETTLE_TICKS: 5,
  COOLDOWN_S: 12,
};

/**
 * Ternary search over concurrency for the smallest value at which the observed
 * container count exceeds `baseline`.
 *
 * Yields probe requests; the caller executes them and feeds results back. This
 * generator shape keeps the solver pure and testable -- there is no NATS, no
 * HTTP and no timing in here, so it can be unit-tested in milliseconds.
 *
 * @param {Object} opts
 * @param {number} opts.lo lowest concurrency to consider
 * @param {number} opts.hi highest concurrency to consider
 * @param {number} opts.baseline container count at idle (normally 1)
 * @param {number} opts.maxProbes hard ceiling on credit spend
 */
export function* findKnee({ lo = 1, hi = 120, baseline = 1, maxProbes = 7 }) {
  let low = lo;
  let high = hi;
  let best = null;
  let probes = 0;

  while (high - low > Math.max(2, low * 0.1) && probes < maxProbes) {
    const mid = Math.round((low + high) / 2);
    const result = yield { concurrency: mid, kind: 'knee-probe', probe: probes };
    probes += 1;

    if (result.containers > baseline) {
      best = { concurrency: mid, ...result };
      high = mid;
    } else {
      low = mid;
    }
  }

  return {
    kneeConcurrency: best?.concurrency ?? null,
    kneeRps: best?.rps ?? null,
    probesUsed: probes,
    bracket: [low, high],
  };
}

/**
 * Sweep the envelope: one settled probe per container count, from 1 up to
 * maxContainers. Returns rows suitable for plotting sustainable RPS against
 * container count -- the curve that tells you whether scaling is linear.
 *
 * In practice it rarely is, and the shape of the deviation is the finding:
 * sub-linear means the target has a shared bottleneck the autoscaler cannot
 * fix by adding containers.
 */
export function* sweepEnvelope({ maxContainers = 6, startConcurrency = 8, growth = 2.0, maxProbes = 8 }) {
  const rows = [];
  let concurrency = startConcurrency;
  let probes = 0;
  let seenContainers = 0;

  while (probes < maxProbes && seenContainers < maxContainers) {
    const result = yield { concurrency: Math.round(concurrency), kind: 'envelope-probe', probe: probes };
    probes += 1;

    if (result.settled) {
      rows.push({
        containers: result.containers,
        sustainableRps: result.rps,
        p95: result.p95,
        concurrency: Math.round(concurrency),
        rpsPerContainer: result.containers ? result.rps / result.containers : 0,
        costPerMillionUsd: result.costPerMillionUsd ?? null,
      });
      seenContainers = Math.max(seenContainers, result.containers);
    }

    concurrency *= growth;
  }

  // Collapse to one row per container count, keeping the best throughput seen.
  const byCount = new Map();
  for (const r of rows) {
    const prev = byCount.get(r.containers);
    if (!prev || r.sustainableRps > prev.sustainableRps) byCount.set(r.containers, r);
  }

  const envelope = [...byCount.values()].sort((a, b) => a.containers - b.containers);
  return { envelope, probesUsed: probes, linearity: linearityScore(envelope) };
}

/**
 * 1.0 means throughput scaled perfectly linearly with containers. Below 1.0
 * means diminishing returns -- the number worth putting on screen.
 */
export function linearityScore(envelope) {
  if (envelope.length < 2) return null;
  const first = envelope[0];
  const last = envelope[envelope.length - 1];
  if (!first.sustainableRps || last.containers === first.containers) return null;
  const idealGain = last.containers / first.containers;
  const actualGain = last.sustainableRps / first.sustainableRps;
  return Math.round((actualGain / idealGain) * 100) / 100;
}
