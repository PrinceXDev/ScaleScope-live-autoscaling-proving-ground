/**
 * Load profiles.
 *
 * A flat load produces a flat chart, and a flat chart is not a finding. Each
 * profile below is a function of normalised run progress (0..1) returning a
 * normalised intensity (0..1), which the worker multiplies by its share of the
 * fleet concurrency budget.
 *
 * These matter for the demo as much as for the science: RAMP produces a chart
 * with a visible knee at the exact concurrency where the first container is
 * added, and SPIKE compresses the entire scale-up story into fifteen seconds,
 * which is the right length for a social video.
 */

export const PROFILE = {
  FLAT: 'flat',
  RAMP: 'ramp',
  STEP: 'step',
  SPIKE: 'spike',
  SAWTOOTH: 'sawtooth',
  /** Not a shape -- the autopilot ignores the shape and seeks a latency target. */
  AUTOPILOT: 'autopilot',
};

export const PROFILE_META = {
  [PROFILE.FLAT]: {
    label: 'Flat',
    blurb: 'Constant load. The baseline everything else is measured against.',
    teaches: 'Steady-state capacity at a fixed concurrency.',
  },
  [PROFILE.RAMP]: {
    label: 'Ramp',
    blurb: 'Zero to maximum, linearly, across the whole window.',
    teaches: 'The exact concurrency at which the first container is added -- the knee.',
  },
  [PROFILE.STEP]: {
    label: 'Step',
    blurb: 'Four plateaus at 25%, 50%, 75%, 100%.',
    teaches: 'Whether the autoscaler settles between changes or keeps hunting.',
  },
  [PROFILE.SPIKE]: {
    label: 'Spike',
    blurb: 'Idle, then instantly maximum, then idle again.',
    teaches: 'Reaction time. How many seconds of pain before capacity arrives.',
  },
  [PROFILE.SAWTOOTH]: {
    label: 'Sawtooth',
    blurb: 'Repeated up-down oscillation across the window.',
    teaches: 'Whether Zerops thrashes containers or damps the oscillation.',
  },
  [PROFILE.AUTOPILOT]: {
    label: 'Autopilot',
    blurb: 'You set a latency target. The fleet finds the load that produces it.',
    teaches: 'Sustainable throughput at a given SLO -- and how it steps up as containers arrive.',
  },
};

/**
 * @param {string} profile
 * @param {number} p normalised progress through the run, 0..1
 * @returns {number} normalised intensity, 0..1
 */
export function intensityAt(profile, p) {
  const x = Math.min(1, Math.max(0, p));
  switch (profile) {
    case PROFILE.RAMP:
      return x;

    case PROFILE.STEP:
      // four equal plateaus; the last one holds to the end
      return Math.min(1, (Math.floor(x * 4) + 1) / 4);

    case PROFILE.SPIKE:
      // 15% idle lead-in, hard step to full, release at 70%
      if (x < 0.15) return 0.02;
      if (x < 0.7) return 1;
      return 0.02;

    case PROFILE.SAWTOOTH: {
      // three full cycles across the window
      const phase = (x * 3) % 1;
      return phase < 0.5 ? phase * 2 : (1 - phase) * 2;
    }

    case PROFILE.AUTOPILOT:
      // the controller owns intensity; this is only the warm-up envelope so a
      // run doesn't slam the target before the PID has any observations
      return Math.min(1, x * 8);

    case PROFILE.FLAT:
    default:
      return 1;
  }
}

/** Pre-render a profile for the UI preview sparkline. */
export function renderProfile(profile, points = 60) {
  return Array.from({ length: points }, (_, i) => intensityAt(profile, i / (points - 1)));
}

export const DEFAULT_RUN = {
  name: 'run',
  profile: PROFILE.SPIKE,
  targetUrl: 'http://target:3000/work',
  rounds: 12000,
  maxConcurrency: 40,
  durationS: 90,
  cooldownS: 90,
  sloP95Ms: 500,
  /** Autopilot latency setpoint; only used when profile === AUTOPILOT. */
  setpointMs: 400,
  chaos: null,
};

/** Server-side ceilings. Enforced in code, not by discipline -- see credit burn. */
export const LIMITS = {
  durationS: 180,
  cooldownS: 180,
  maxConcurrency: 200,
  rounds: 60_000,
};

export function clampRunConfig(input = {}) {
  const cfg = { ...DEFAULT_RUN, ...input };
  cfg.durationS = Math.min(LIMITS.durationS, Math.max(5, Number(cfg.durationS) || DEFAULT_RUN.durationS));
  cfg.cooldownS = Math.min(LIMITS.cooldownS, Math.max(0, Number(cfg.cooldownS) ?? DEFAULT_RUN.cooldownS));
  cfg.maxConcurrency = Math.min(LIMITS.maxConcurrency, Math.max(1, Number(cfg.maxConcurrency) || DEFAULT_RUN.maxConcurrency));
  cfg.rounds = Math.min(LIMITS.rounds, Math.max(1000, Number(cfg.rounds) || DEFAULT_RUN.rounds));
  cfg.sloP95Ms = Math.max(1, Number(cfg.sloP95Ms) || DEFAULT_RUN.sloP95Ms);
  cfg.setpointMs = Math.max(1, Number(cfg.setpointMs) || DEFAULT_RUN.setpointMs);
  if (!Object.values(PROFILE).includes(cfg.profile)) cfg.profile = DEFAULT_RUN.profile;
  return cfg;
}
