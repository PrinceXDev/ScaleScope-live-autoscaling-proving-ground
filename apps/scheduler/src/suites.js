/**
 * Suite execution.
 *
 * A suite is an unattended sequence of runs. What varies between suite kinds
 * is only how the *next* run's config is chosen -- a fixed list, or a
 * generator from @scalescope/control reacting to what the previous probe
 * measured. The execution mechanics (start a run through the gateway, wait for
 * it to finish, extract a result) are identical across all four kinds and live
 * in one function, `executeStep`, so a bug in "how do we wait for a run to
 * end" cannot exist in four slightly different versions.
 *
 * ==========================================================================
 * WHY THIS GOES THROUGH THE GATEWAY'S PUBLIC API RATHER THAN CTRL.* DIRECTLY
 * ==========================================================================
 * The scheduler could import @scalescope/bus and publish CTRL.PREPARE / GO
 * itself -- it has the same access to NATS the gateway does. That would be a
 * mistake, because the gateway is not just a publisher of those subjects, it
 * is the holder of three invariants that make a run safe to start at all: the
 * hourly credit budget, the single-active-run lock, and the two-phase start
 * barrier. Any second component that starts runs by talking to the fleet
 * directly is a second place those invariants have to be enforced correctly,
 * and the two implementations will drift the day one of them changes. Going
 * through `POST /api/runs` means the scheduler gets those guarantees for free
 * and can never accidentally originate a run the gateway doesn't know about --
 * which matters specifically here, because a suite is exactly the kind of
 * component that could otherwise loop past the credit ceiling without anyone
 * watching.
 * ==========================================================================
 */

import { findKnee, sweepEnvelope, PROBE } from '@scalescope/control';
import { log, sleep } from '@scalescope/telemetry';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://gateway:3000';

export class BudgetExceeded extends Error {
  constructor(reason) { super(reason); this.name = 'BudgetExceeded'; }
}

/**
 * Start one run via the gateway, wait for its terminal broadcast, and return
 * enough of its outcome for a suite generator to react to.
 *
 * Waiting is done by polling `GET /api/runs/:id` rather than subscribing to
 * UI.BROADCAST here, deliberately: a suite step already has a hard timeout, and
 * polling every two seconds against a REST endpoint that is going to exist
 * regardless is one dependency simpler than holding a NATS subscription open
 * across a step that might last minutes. The live progress bar the Lab view
 * shows during a suite is driven by the *run's own* broadcasts, which every
 * client (including a suite's own runs) already produces -- the scheduler does
 * not need to re-broadcast anything to make that work.
 */
async function executeStep(config, { hardTimeoutMs }) {
  const startRes = await fetch(`${GATEWAY_URL}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });

  if (startRes.status === 429) {
    throw new BudgetExceeded('gateway hourly run budget exhausted');
  }
  if (!startRes.ok) {
    const body = await startRes.json().catch(() => ({}));
    throw new Error(`start run failed: ${startRes.status} ${body.error || ''}`);
  }
  const { runId } = await startRes.json();

  const deadline = Date.now() + hardTimeoutMs;
  let run = null;
  while (Date.now() < deadline) {
    await sleep(2000);
    const res = await fetch(`${GATEWAY_URL}/api/runs/${runId}`);
    if (!res.ok) continue;
    run = await res.json();
    if (run.status === 'completed' || run.status === 'failed') break;
  }

  if (!run || (run.status !== 'completed' && run.status !== 'failed')) {
    // The run outlived its own generous timeout. Stop it explicitly rather
    // than walking away -- an orphaned run left running is exactly the
    // credit-burning failure mode the rest of this codebase goes out of its
    // way to avoid.
    log.warn(`step run ${runId} did not finish in time; stopping it`);
    await fetch(`${GATEWAY_URL}/api/runs/${runId}/stop`, { method: 'POST' }).catch(() => {});
    await sleep(1500);
    const res = await fetch(`${GATEWAY_URL}/api/runs/${runId}`).catch(() => null);
    run = res && res.ok ? await res.json() : { status: 'failed' };
  }

  const timelineRes = await fetch(`${GATEWAY_URL}/api/runs/${runId}/timeline`).catch(() => null);
  const timeline = timelineRes && timelineRes.ok ? await timelineRes.json() : [];

  return { runId, run, timeline };
}

/** Did the run settle at a steady state, rather than merely peaking transiently? */
function isSettled(timeline, tailSeconds = PROBE.SETTLE_TICKS) {
  if (timeline.length < tailSeconds) return false;
  const tail = timeline.slice(-tailSeconds);
  const containers = tail.map((r) => r.containers);
  return containers.every((c) => c === containers[0]);
}

function summarise(timeline) {
  if (!timeline.length) return { containers: 0, rps: 0, p95: 0, settled: false };
  const peakContainers = Math.max(...timeline.map((r) => r.containers));
  const tail = timeline.slice(-PROBE.SETTLE_TICKS);
  const settledRps = tail.length ? Math.round(tail.reduce((a, r) => a + r.rps, 0) / tail.length) : 0;
  const settledP95 = tail.length ? Math.max(...tail.map((r) => r.p95)) : 0;
  return { containers: peakContainers, rps: settledRps, p95: settledP95, settled: isSettled(timeline) };
}

// ---------------------------------------------------------------------------
// Suite kinds
// ---------------------------------------------------------------------------

/** A fixed, ordered list of run configs, executed in sequence with a cooldown gap between them. */
export async function* runManual(steps, guard) {
  for (const step of steps) {
    guard();
    const config = { ...step, durationS: step.durationS ?? 60, cooldownS: step.cooldownS ?? 30 };
    const { runId, run, timeline } = await executeStep(config, { hardTimeoutMs: stepTimeout(config) });
    yield { config, runId, run, summary: summarise(timeline) };
  }
}

/**
 * Drives findKnee(): short probes, ternary search, converging on the smallest
 * concurrency at which a second container appears. Each probe becomes a real,
 * short run against the fleet -- this is empirical, not simulated -- which is
 * why probes are capped and short (PROBE.DURATION_S) rather than full-length
 * runs; a full sweep at ninety seconds a probe would burn the suite's entire
 * credit ceiling finding one number.
 */
export async function* runKnee({ lo = 1, hi = 120, maxProbes = 7 } = {}, guard) {
  const gen = findKnee({ lo, hi, baseline: 1, maxProbes });
  let next = gen.next();
  while (!next.done) {
    guard();
    const probeReq = next.value;
    const config = {
      name: `knee-probe-${probeReq.probe}`,
      profile: 'flat',
      maxConcurrency: probeReq.concurrency,
      durationS: PROBE.DURATION_S,
      cooldownS: PROBE.COOLDOWN_S,
    };
    const { runId, run, timeline } = await executeStep(config, { hardTimeoutMs: stepTimeout(config) });
    const summary = summarise(timeline);
    yield { config, runId, run, summary, probe: probeReq };
    next = gen.next({ containers: summary.containers, rps: summary.rps });
  }
  return next.value; // { kneeConcurrency, kneeRps, probesUsed, bracket }
}

/**
 * Drives sweepEnvelope(): one settled probe per container count, producing the
 * sustainable-RPS-per-container curve and its linearity score. This is the
 * suite that answers "does throughput scale the way the marketing slide
 * implies", and the honest answer is frequently "not quite" -- which is the
 * point of measuring rather than assuming.
 */
export async function* runEnvelope({ maxContainers = 6, startConcurrency = 8, growth = 2.0, maxProbes = 8 } = {}, guard) {
  const gen = sweepEnvelope({ maxContainers, startConcurrency, growth, maxProbes });
  let next = gen.next();
  while (!next.done) {
    guard();
    const probeReq = next.value;
    const config = {
      name: `envelope-probe-${probeReq.probe}`,
      profile: 'flat',
      maxConcurrency: probeReq.concurrency,
      durationS: PROBE.DURATION_S,
      cooldownS: PROBE.COOLDOWN_S,
    };
    const { runId, run, timeline } = await executeStep(config, { hardTimeoutMs: stepTimeout(config) });
    const summary = summarise(timeline);
    yield { config, runId, run, summary, probe: probeReq };
    next = gen.next({
      containers: summary.containers,
      rps: summary.rps,
      p95: summary.p95,
      settled: summary.settled,
    });
  }
  return next.value; // { envelope, probesUsed, linearity }
}

/**
 * A fixed standard profile, run once, compared against the previous
 * regression run's summary. This is what turns a one-off demo into a
 * longitudinal record -- run nightly (see cron.js), it answers "did anything
 * about the platform's scaling behaviour change since yesterday", which no
 * single run, however impressive, can answer on its own.
 */
export const REGRESSION_CONFIG = {
  name: 'nightly-regression',
  profile: 'spike',
  maxConcurrency: 40,
  rounds: 12000,
  durationS: 90,
  cooldownS: 90,
  sloP95Ms: 500,
};

export async function* runRegression(previous, guard) {
  guard();
  const { runId, run, timeline } = await executeStep(REGRESSION_CONFIG, { hardTimeoutMs: stepTimeout(REGRESSION_CONFIG) });
  const summary = summarise(timeline);
  const delta = previous ? {
    peakContainersDelta: (run.peak_containers ?? summary.containers) - (previous.peakContainers ?? 0),
    peakP95Delta: (run.peak_p95_ms ?? summary.p95) - (previous.peakP95 ?? 0),
    timeToRecoverDelta: (run.time_to_recover_s ?? null) - (previous.timeToRecoverS ?? 0),
  } : null;
  yield { config: REGRESSION_CONFIG, runId, run, summary, delta };
  return {
    peakContainers: run.peak_containers ?? summary.containers,
    peakP95: run.peak_p95_ms ?? summary.p95,
    timeToRecoverS: run.time_to_recover_s ?? null,
    delta,
  };
}

function stepTimeout(config) {
  return (Number(config.durationS || 90) + Number(config.cooldownS || 90) + 90) * 1000;
}
