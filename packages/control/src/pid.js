import { clamp } from '@scalescope/telemetry';

/**
 * The autopilot.
 *
 * Every load testing tool works the same way: you pick a concurrency, you fire,
 * you read the latency that comes out. That answers "what happens at 40
 * concurrent requests", which is rarely the question anyone actually has.
 *
 * ScaleScope inverts it. You give it a latency you are willing to tolerate --
 * "keep p95 under 400ms" -- and a PID controller adjusts in-flight concurrency
 * every tick to hold the system exactly at that boundary. The output is no
 * longer a latency curve; it is a *throughput* curve, and it answers the
 * question people actually have: how many requests per second can this thing
 * serve at an acceptable latency?
 *
 * The reason this is worth building on Zerops specifically: when the platform
 * adds a container, sustainable throughput at the same latency jumps. The
 * controller finds the new ceiling within a few seconds and pushes load up to
 * meet it. So the chart you get is a flat latency line with a staircase of
 * throughput underneath it, and every step in that staircase is a container
 * being added. That is a far more direct picture of what autoscaling buys you
 * than a latency spike that recovers.
 *
 * Tuning notes, learned the hard way:
 *  - The plant (a CPU-bound service behind an autoscaler) has significant dead
 *    time. Derivative gain must stay small or the controller chases noise.
 *  - Integral windup is the failure mode that matters: during the seconds
 *    between saturation and a new container arriving, error stays large and a
 *    naive integrator accumulates a huge correction that then overshoots
 *    violently the moment capacity lands. We clamp the integral term and, more
 *    importantly, freeze it entirely while the output is saturated at a limit.
 *  - Output is rate-limited on the way up but not on the way down. Backing off
 *    fast is always safe; ramping fast is how you DoS your own target.
 */
export class LatencyAutopilot {
  /**
   * @param {Object} opts
   * @param {number} opts.setpointMs   target p95
   * @param {number} opts.minConcurrency
   * @param {number} opts.maxConcurrency
   * @param {number} [opts.kp] proportional gain, in concurrency units per unit of normalised error
   * @param {number} [opts.ki] integral gain
   * @param {number} [opts.kd] derivative gain
   */
  constructor({
    setpointMs,
    minConcurrency = 1,
    maxConcurrency = 200,
    kp = 6,
    ki = 1.2,
    kd = 0.8,
  }) {
    this.setpointMs = setpointMs;
    this.min = minConcurrency;
    this.max = maxConcurrency;
    this.kp = kp;
    this.ki = ki;
    this.kd = kd;

    this.integral = 0;
    this.lastError = 0;
    this.output = minConcurrency;
    this.saturated = false;
    this.history = [];
  }

  retarget(setpointMs) {
    if (setpointMs === this.setpointMs) return;
    this.setpointMs = setpointMs;
    // Retargeting invalidates accumulated correction; keeping it would drag the
    // controller toward the old operating point for several ticks.
    this.integral = 0;
  }

  /**
   * @param {number} observedP95Ms
   * @param {number} dtS seconds since last update
   * @returns {number} concurrency the fleet should hold this tick
   */
  update(observedP95Ms, dtS = 1) {
    // Normalised error: how far off target we are as a fraction of target.
    // Normalising means one set of gains works whether the setpoint is 50ms or
    // 5000ms, which matters because the setpoint is a user-facing dial.
    const error = (this.setpointMs - observedP95Ms) / this.setpointMs;

    // Anti-windup: only integrate when we are not pinned at a limit. If the
    // output is already at max and we still want more, accumulating is
    // pointless and actively harmful on the way back down.
    const pushingIntoLimit = (this.saturated && error > 0) || (this.output <= this.min && error < 0);
    if (!pushingIntoLimit) {
      this.integral = clamp(this.integral + error * dtS, -8, 8);
    }

    const derivative = (error - this.lastError) / Math.max(dtS, 0.001);
    this.lastError = error;

    const correction = this.kp * error + this.ki * this.integral + this.kd * derivative;

    // Multiplicative on a proportional base: at concurrency 100 a correction of
    // "+1 unit" is noise, at concurrency 2 it is a doubling. Scaling the step by
    // current output keeps the controller's responsiveness consistent across
    // three orders of magnitude of load.
    const step = correction * Math.max(1, this.output * 0.25);

    // Asymmetric rate limit: ease up gently, back off immediately.
    const maxRise = Math.max(2, this.output * 0.4);
    const bounded = step > maxRise ? maxRise : step;

    const next = clamp(Math.round(this.output + bounded), this.min, this.max);
    this.saturated = next >= this.max;
    this.output = next;

    this.history.push({ error, integral: this.integral, output: next, observedP95Ms });
    if (this.history.length > 300) this.history.shift();

    return next;
  }

  /**
   * Has the controller settled? Used by the capacity-envelope solver to know
   * when a probe has produced a trustworthy number rather than a transient.
   */
  isSettled(ticks = 5, tolerance = 0.08) {
    if (this.history.length < ticks) return false;
    const recent = this.history.slice(-ticks);
    return recent.every((h) => Math.abs(h.error) < tolerance);
  }

  reset() {
    this.integral = 0;
    this.lastError = 0;
    this.output = this.min;
    this.saturated = false;
    this.history = [];
  }
}
