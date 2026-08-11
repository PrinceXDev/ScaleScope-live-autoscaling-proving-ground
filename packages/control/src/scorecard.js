/**
 * The Autoscaler Report Card.
 *
 * Every other number this project produces describes one run. This one
 * describes the platform: the same six metrics, computed the same way, on
 * every run, so a grade from a run today is comparable to a grade from a run
 * three weeks ago -- or to a grade the Zerops team reproduces themselves by
 * running this function over their own event log. That comparability is the
 * entire point, which is why every metric here is a pure function of the
 * run's timeline and nothing else: no wall-clock reads, no service calls, no
 * hidden state that would make two runs of the same load profile grade
 * differently for reasons unrelated to the platform's behaviour.
 *
 * This is a capability report, not a verdict. Each metric is defined in
 * plain language right next to its number wherever it is displayed, because
 * a grade with a hidden method reads as an accusation and a grade with a
 * visible one reads as a measurement -- and measurement is the only claim
 * this file is entitled to make.
 *
 * Inputs, all optional except `folded`:
 *   - folded              the `foldRun()` projection (status, scaleEvents,
 *                          chaosEvents, sloBreachAt/sloRecoverAt, config, ...)
 *   - events              the raw ordered event log for the run. Needed
 *                          because `foldRun` only keeps the *current* phase,
 *                          not a history of phase transitions or every SLO
 *                          crossing -- several metrics here need the full
 *                          sequence, not the collapsed summary.
 *   - timeline            per-second rows `{ t, containers, rps, p95 }[]`,
 *                          e.g. from the `run_timeline` ClickHouse view. A
 *                          handful of metrics (settling time, overshoot,
 *                          cost efficiency) need a continuous curve that the
 *                          event log alone does not carry; without it those
 *                          metrics report `null` rather than guess.
 *   - capacityPerContainer the platform's learned req/s-per-container, e.g.
 *                          the oracle twin's fitted parameter for this
 *                          target. This is the one number in the whole
 *                          report the platform does not publish -- it has to
 *                          be learned -- so overshoot and cost efficiency are
 *                          only as honest as this estimate. Falls back to
 *                          DEFAULT_CAPACITY_PER_CONTAINER, clearly labelled
 *                          as an assumption, if the caller has nothing
 *                          better.
 *
 * Every metric function below can be read and tested on its own; compute()
 * just wires them together and rolls them into a composite grade.
 */

/** Used only when no learned capacity estimate is available for the target. */
export const DEFAULT_CAPACITY_PER_CONTAINER = 20;

/** A scale event is "settled" once containers stay within this band of the target level. */
const SETTLE_BAND = 1;
/** ...for this many consecutive seconds. */
const SETTLE_HOLD_S = 5;

const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * SLO breach to first container that starts serving as a result of it.
 *
 * Measured from the `slo` event marking the breach to the first `scaled`
 * event with `to > from` at or after that timestamp. Not "first scale of any
 * kind" -- a scale-down mid-breach (e.g. a stale cooldown tick) should not
 * count as the platform's reaction.
 */
export function reactionTime(events, sloBreachAt) {
  if (sloBreachAt == null) return null;
  const scaleUp = events.find((e) => e.type === 'scaled' && e.data.to > e.data.from && e.data.t >= sloBreachAt);
  if (!scaleUp) return null;
  return round(scaleUp.data.t - sloBreachAt);
}

/**
 * Load step (or breach) to container count holding steady at its new level.
 *
 * Walks the per-second timeline forward from `fromT`, finds the last
 * container-count change, then measures how long it takes for the count to
 * stay within SETTLE_BAND of its eventual level for SETTLE_HOLD_S straight
 * seconds. Requires a continuous timeline; returns null without one rather
 * than approximating from sparse scale events, since "settled" is a
 * statement about the whole curve, not a single transition.
 */
export function settlingTime(timeline, fromT) {
  if (!timeline?.length) return null;
  const rows = timeline.filter((r) => r.t >= fromT).sort((a, b) => a.t - b.t);
  if (rows.length < SETTLE_HOLD_S + 1) return null;

  for (let i = 0; i < rows.length; i += 1) {
    const window = rows.slice(i, i + SETTLE_HOLD_S);
    if (window.length < SETTLE_HOLD_S) break;
    const level = window[window.length - 1].containers;
    const allWithinBand = window.every((r) => Math.abs(r.containers - level) <= SETTLE_BAND);
    if (allWithinBand) return round(window[0].t - fromT);
  }
  return null;
}

/**
 * Peak containers actually run, divided by peak containers the observed load
 * implied were needed (peak rps / capacityPerContainer, rounded up). 1.0 is
 * exact provisioning; above 1.0 is headroom the run paid for and did not use.
 */
export function overshoot(timeline, capacityPerContainer) {
  if (!timeline?.length) return null;
  let peakContainers = 0;
  let peakNeeded = 0;
  for (const r of timeline) {
    peakContainers = Math.max(peakContainers, r.containers || 0);
    const needed = Math.ceil((r.rps || 0) / Math.max(1, capacityPerContainer));
    peakNeeded = Math.max(peakNeeded, needed);
  }
  if (peakNeeded === 0) return null;
  return round(peakContainers / peakNeeded);
}

/**
 * Scale-direction reversals per minute of run duration -- how often the
 * autoscaler changed its mind. A single ramp up and back down at the end of
 * a load step is zero flaps; scaling up, down, up again inside one step is
 * two reversals. High flap scores mean thin hysteresis, not high activity,
 * which is why this counts direction *changes* rather than scale events.
 */
export function flapScore(scaleEvents, durationS) {
  if (!scaleEvents?.length || !durationS) return null;
  const sorted = [...scaleEvents].sort((a, b) => a.t - b.t);
  let reversals = 0;
  let lastDir = null;
  for (const e of sorted) {
    const dir = e.to > e.from ? 1 : e.to < e.from ? -1 : 0;
    if (dir === 0) continue;
    if (lastDir != null && dir !== lastDir) reversals += 1;
    lastDir = dir;
  }
  return round((reversals / durationS) * 60);
}

/**
 * Container-seconds actually spent, divided by container-seconds the
 * observed load implied were required. 1.0 means every container-second ran
 * against a container-second of demand; above 1.0 is the cost of headroom,
 * cooldown lag, and conservative scale-down.
 */
export function costEfficiency(timeline, capacityPerContainer) {
  if (!timeline?.length) return null;
  let spent = 0;
  let required = 0;
  for (const r of timeline) {
    spent += r.containers || 0;
    required += Math.ceil((r.rps || 0) / Math.max(1, capacityPerContainer));
  }
  if (required === 0) return null;
  return round(spent / required);
}

/**
 * Chaos injection to p95 back under the run's SLO, sustained for
 * SETTLE_HOLD_S seconds. Uses the timeline if available for a precise
 * sustained-recovery reading; falls back to the SLO breach/recover event
 * pair folded by `foldRun` (whichever breach follows the chaos event) when
 * no timeline is supplied.
 */
export function recoveryTime(timeline, chaosAt, sloP95Ms, folded) {
  if (chaosAt == null) return null;

  if (timeline?.length) {
    const rows = timeline.filter((r) => r.t >= chaosAt).sort((a, b) => a.t - b.t);
    for (let i = 0; i < rows.length; i += 1) {
      const window = rows.slice(i, i + SETTLE_HOLD_S);
      if (window.length < SETTLE_HOLD_S) break;
      if (window.every((r) => r.p95 <= sloP95Ms)) return round(window[0].t - chaosAt);
    }
    return null;
  }

  if (folded?.sloBreachAt != null && folded.sloBreachAt >= chaosAt && folded.sloRecoverAt != null) {
    return round(folded.sloRecoverAt - folded.sloBreachAt);
  }
  return null;
}

/**
 * Each metric's raw units point different directions (lower is better for
 * all of them here) and live on different scales, so grading needs each one
 * mapped onto a common 0-100 "how good" axis before they can be averaged.
 * `good` is the value that scores 100, `bad` is the value that scores 0;
 * anything past `bad` clamps to 0 rather than going negative.
 */
function subScore(value, good, bad) {
  if (value == null) return null;
  const t = (bad - value) / (bad - good);
  return Math.max(0, Math.min(100, t * 100));
}

const GRADE_BANDS = [
  { min: 97, grade: 'A+' }, { min: 93, grade: 'A' }, { min: 90, grade: 'A-' },
  { min: 87, grade: 'B+' }, { min: 83, grade: 'B' }, { min: 80, grade: 'B-' },
  { min: 77, grade: 'C+' }, { min: 73, grade: 'C' }, { min: 70, grade: 'C-' },
  { min: 60, grade: 'D' }, { min: 0, grade: 'F' },
];

function letterGrade(score) {
  if (score == null) return null;
  return GRADE_BANDS.find((b) => score >= b.min).grade;
}

/**
 * Compute the full report card for one completed run.
 *
 * @param {Object} opts
 * @param {Object} opts.folded    `foldRun()` output for this run
 * @param {Array}  opts.events    raw ordered event log: `{ type, data, seq }[]`
 * @param {Array}  [opts.timeline] per-second rows: `{ t, containers, rps, p95 }[]`
 * @param {number} [opts.capacityPerContainer] learned req/s per container
 */
export function computeScorecard({ folded, events = [], timeline = null, capacityPerContainer = DEFAULT_CAPACITY_PER_CONTAINER }) {
  const durationS = folded?.config?.durationS ?? null;
  const sloP95Ms = folded?.config?.sloP95Ms ?? null;
  const lastChaos = [...(folded?.chaosEvents || [])].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).pop();
  const chaosAtT = lastChaos ? (lastChaos.t ?? null) : null;

  const firstScale = [...(folded?.scaleEvents || [])].sort((a, b) => a.t - b.t)[0];

  const metrics = {
    reactionTimeS: reactionTime(events, folded?.sloBreachAt),
    settlingTimeS: settlingTime(timeline, firstScale?.t ?? 0),
    overshootRatio: overshoot(timeline, capacityPerContainer),
    flapPerMinute: flapScore(folded?.scaleEvents, durationS),
    costEfficiencyRatio: costEfficiency(timeline, capacityPerContainer),
    recoveryTimeS: recoveryTime(timeline, chaosAtT, sloP95Ms, folded),
  };

  const subScores = {
    reactionTimeS: subScore(metrics.reactionTimeS, 2, 30),
    settlingTimeS: subScore(metrics.settlingTimeS, 5, 60),
    overshootRatio: subScore(metrics.overshootRatio, 1, 3),
    flapPerMinute: subScore(metrics.flapPerMinute, 0, 6),
    costEfficiencyRatio: subScore(metrics.costEfficiencyRatio, 1, 2.5),
    recoveryTimeS: subScore(metrics.recoveryTimeS, 3, 45),
  };

  const available = Object.values(subScores).filter((v) => v != null);
  const composite = available.length ? available.reduce((a, b) => a + b, 0) / available.length : null;

  return {
    v: 1,
    metrics,
    subScores: Object.fromEntries(Object.entries(subScores).map(([k, v]) => [k, round(v, 1)])),
    composite: round(composite, 1),
    grade: letterGrade(composite),
    methodology: {
      reactionTimeS: 'SLO breach to first container added in response',
      settlingTimeS: `container count within ±${SETTLE_BAND} of its new level for ${SETTLE_HOLD_S}s straight`,
      overshootRatio: 'peak containers run ÷ peak containers the observed load implied were needed',
      flapPerMinute: 'scale-direction reversals per minute of run duration',
      costEfficiencyRatio: 'container-seconds spent ÷ container-seconds the observed load required',
      recoveryTimeS: `chaos injected to p95 back under the run's SLO for ${SETTLE_HOLD_S}s straight`,
    },
    assumptions: { capacityPerContainer },
  };
}
