/**
 * The golden run: a static, committed fixture replayed entirely client-side.
 *
 * Judging is asynchronous and happens on someone else's schedule -- a cold
 * ClickHouse container, a spent hourly run budget, Zerops having a bad
 * afternoon, or a judge on a plane with no connectivity to the gateway at
 * all. The live showcase (`api.showcase()` + `openStream({ replay: true })`)
 * is a great demo when the backend is warm and a blank chart when it isn't.
 * This is the fallback that cannot fail: `golden-run.json` ships as a static
 * asset in the same deploy as the page that reads it, so playing it back
 * requires nothing more than the browser having already loaded the site.
 *
 * `playGoldenRun` paces the fixture's events using the exact same algorithm
 * as `replayRun` in `apps/gateway/src/replay.js` -- same gap computation
 * (`emittedAt[i] - emittedAt[i-1]`, clamped to MAX_GAP_MS, divided by speed),
 * same event-name mapping, same "one code path" property the SSE replay
 * engine was built around. This file is that algorithm's client-only twin,
 * not a reinterpretation of it: if you change the pacing rules on one side,
 * change them on the other, or the golden run stops feeling like the same
 * product as a live replay.
 *
 * The one deliberate difference: this never touches the network beyond the
 * initial fetch of the static JSON. No EventSource, no server round-trip, no
 * dependency on the gateway process existing, let alone being healthy.
 */

const MAX_GAP_MS = 2000;
const SPEED_MIN = 0.25;
const SPEED_MAX = 20;

/** Mirrors `SSE_NAME_FOR_EVENT` in apps/gateway/src/replay.js -- event type -> SSE event name on the wire. */
const SSE_NAME_FOR_EVENT = {
  created: 'run.created',
  armed: 'run.armed',
  started: 'run.started',
  tick: 'tick',
  scaled: 'scaled',
  phase: 'phase',
  chaos: 'chaos',
  prediction: 'prediction',
  finding: 'finding',
  slo: 'slo',
  completed: 'run.completed',
  failed: 'run.failed',
};

function normaliseSpeed(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, n));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let cachedFixture = null;

async function loadFixture() {
  if (cachedFixture) return cachedFixture;
  const res = await fetch('/golden-run.json', { cache: 'force-cache' });
  if (!res.ok) throw new Error(`golden-run.json fetch failed: ${res.status}`);
  cachedFixture = await res.json();
  return cachedFixture;
}

/** Run metadata only -- lets a caller show a name/grade badge before deciding to play it. */
export async function goldenRunInfo() {
  const fixture = await loadFixture();
  return fixture.run;
}

/**
 * Play the golden run into `onEvent(name, data)`, at the same pace it
 * actually happened (divided by `speed`). Returns a stop function, same
 * calling convention as `openStream`.
 *
 * @param {(event: string, data: any) => void} onEvent
 * @param {{ speed?: number, loop?: boolean }} [opts]
 * @returns {() => void} stop
 */
export function playGoldenRun(onEvent, opts = {}) {
  const mult = normaliseSpeed(opts.speed);
  let stopped = false;

  (async () => {
    try {
      const fixture = await loadFixture();
      const events = fixture.events || [];
      if (stopped || events.length === 0) return;

      do {
        let prevAt = events[0].emittedAt ?? Date.now();
        for (const env of events) {
          if (stopped) return;

          const at = env.emittedAt ?? prevAt;
          const gap = Math.min(MAX_GAP_MS, Math.max(0, at - prevAt));
          prevAt = at;
          if (gap > 0) await sleep(gap / mult);
          if (stopped) return;

          const name = SSE_NAME_FOR_EVENT[env.type];
          if (!name) continue;
          onEvent(name, env.data);
        }
        onEvent('replay.end', { runId: fixture.run?.id, emitted: events.length, degraded: false, golden: true, speed: mult });
      } while (opts.loop && !stopped);
    } catch (err) {
      onEvent('replay.end', { error: `golden run playback failed: ${err.message}`, degraded: true, golden: true });
    }
  })();

  return () => { stopped = true; };
}
