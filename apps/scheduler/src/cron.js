/**
 * In-process regression timer.
 *
 * Zerops also supports cron directly in `zerops.yaml` under the service's
 * `run.crontab` key (see apps/scheduler/zerops.yaml), which is the right place
 * for this in production because it survives the scheduler container itself
 * being recycled. This in-process timer exists so the exact same code path
 * works in local development without a platform to lean on, and so the
 * scheduler is self-triggering if `REGRESSION_CRON_HOUR` is set even on a
 * deploy where the crontab entry was left out.
 */

import { log } from '@scalescope/telemetry';

const HOUR = Number(process.env.REGRESSION_CRON_HOUR);

/** @param {() => Promise<void>} runRegressionSuite */
export function startRegressionTimer(runRegressionSuite) {
  if (!Number.isFinite(HOUR) || HOUR < 0 || HOUR > 23) {
    log.info('REGRESSION_CRON_HOUR not set; nightly regression timer disabled (zerops.yaml crontab can still trigger one)');
    return;
  }

  let lastFiredDate = null;

  const tick = () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === HOUR && lastFiredDate !== today) {
      lastFiredDate = today;
      log.info(`firing scheduled nightly regression suite (hour=${HOUR} UTC)`);
      runRegressionSuite().catch((err) => log.error(`nightly regression failed: ${err.message}`));
    }
  };

  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  log.info(`nightly regression timer armed for ${HOUR}:00 UTC`);
}
