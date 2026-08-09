export * from './subjects.js';
export * from './events.js';
export * from './frames.js';
export * from './profiles.js';

/** Bumped whenever the wire format changes. Services log a warning on mismatch. */
export const CONTRACT_VERSION = 1;

/**
 * Cost model. Zerops bills per container-hour and the exact rate depends on
 * core package, CPU mode and RAM, so this is deliberately a single tunable
 * constant rather than a pretend-precise formula. The dashboard labels every
 * figure derived from it as an estimate.
 *
 * Override with COST_PER_CONTAINER_HOUR_USD at deploy time once you've read
 * your own pricing page.
 */
export const COST_PER_CONTAINER_HOUR_USD = Number(
  process.env.COST_PER_CONTAINER_HOUR_USD ?? 0.012,
);

/** @param {number} containerSeconds */
export const estimateCost = (containerSeconds) =>
  (containerSeconds / 3600) * COST_PER_CONTAINER_HOUR_USD;
