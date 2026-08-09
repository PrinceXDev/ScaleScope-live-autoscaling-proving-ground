import { create } from 'zustand';

/**
 * One store, one reducer, one frame shape.
 *
 * Every view in the application - the live console, a permalink replay, and the
 * scroll-scrubbed story page - pushes TickFrames through `ingestTick`. There is
 * no separate "replay state" and no separate "story state". That is the whole
 * architectural trick on the frontend, and it is what stops the three surfaces
 * drifting apart as the build goes on.
 */

const MAX_POINTS = 900; // 15 minutes of one-second frames

const emptySeries = () => ({
  t: [], rps: [], p95: [], p50: [], containers: [], predicted: [], errors: [], concurrency: [],
});

export const useStore = create((set, get) => ({
  // ---- connection ----
  connected: false,
  source: 'idle',            // 'live' | 'replay' | 'story' | 'idle'
  ingestLagMs: 0,

  // ---- current run ----
  runId: null,
  runConfig: null,
  status: 'idle',
  phase: 'idle',
  frame: null,               // most recent TickFrame
  series: emptySeries(),

  // ---- derived / annotations ----
  scaleEvents: [],           // [{ t, from, to }]
  chaosEvents: [],           // [{ t, kind, detail }]
  sloEvents: [],             // [{ t, state }]
  instances: new Map(),      // id -> { id, firstT, lastT, requests, peakP95 }
  workers: new Set(),

  peak: { containers: 0, rps: 0, p95: 0 },
  timeToRecoverS: null,
  costUsd: 0,

  // ---- catalogue ----
  runs: [],
  topology: null,
  budget: null,

  setConnected: (connected) => set({ connected }),
  setSource: (source) => set({ source }),
  setTopology: (topology) => set({ topology }),
  setBudget: (budget) => set({ budget }),
  setRuns: (runs) => set({ runs }),

  resetRun: (runId = null, runConfig = null, source = 'live') => set({
    runId,
    runConfig,
    source,
    status: runId ? 'running' : 'idle',
    phase: runId ? 'load' : 'idle',
    frame: null,
    series: emptySeries(),
    scaleEvents: [],
    chaosEvents: [],
    sloEvents: [],
    instances: new Map(),
    peak: { containers: 0, rps: 0, p95: 0 },
    timeToRecoverS: null,
    costUsd: 0,
  }),

  /**
   * The single ingest path. Appends to the flat typed-ish arrays uPlot wants
   * (parallel arrays, not array-of-objects) and updates derived aggregates in
   * the same pass so no component ever recomputes a peak from the full series.
   */
  ingestTick: (f) => set((s) => {
    if (s.runId && f.runId && f.runId !== s.runId) return s;

    const series = s.series;
    series.t.push(f.t);
    series.rps.push(f.rps);
    series.p95.push(f.p95);
    series.p50.push(f.p50);
    series.containers.push(f.containers);
    series.predicted.push(f.predicted ?? null);
    series.errors.push(f.errors);
    series.concurrency.push(f.concurrency);

    if (series.t.length > MAX_POINTS) {
      for (const k of Object.keys(series)) series[k].shift();
    }

    const instances = s.instances;
    for (const inst of f.instances || []) {
      const prev = instances.get(inst.id);
      if (prev) {
        prev.lastT = f.t;
        prev.requests += inst.requests;
        prev.peakP95 = Math.max(prev.peakP95, inst.p95);
      } else {
        instances.set(inst.id, {
          id: inst.id, firstT: f.t, lastT: f.t,
          requests: inst.requests, peakP95: inst.p95, ageMs: inst.ageMs,
        });
      }
    }

    return {
      frame: f,
      phase: f.phase,
      ingestLagMs: f.ingestLagMs ?? s.ingestLagMs,
      costUsd: f.costUsd ?? s.costUsd,
      series: { ...series },
      instances: new Map(instances),
      peak: {
        containers: Math.max(s.peak.containers, f.containers || 0),
        rps: Math.max(s.peak.rps, f.rps || 0),
        p95: Math.max(s.peak.p95, f.p95 || 0),
      },
    };
  }),

  pushScale: (e) => set((s) => ({ scaleEvents: [...s.scaleEvents, e] })),
  pushChaos: (e) => set((s) => ({ chaosEvents: [...s.chaosEvents, e] })),
  pushSlo: (e) => set((s) => ({
    sloEvents: [...s.sloEvents, e],
    timeToRecoverS: e.timeToRecoverS ?? s.timeToRecoverS,
  })),
  seeWorker: (id) => set((s) => {
    if (s.workers.has(id)) return s;
    const workers = new Set(s.workers);
    workers.add(id);
    return { workers };
  }),
  completeRun: (summary) => set({ status: 'completed', phase: 'idle', ...(summary || {}) }),

  /** Load a whole timeline at once - used by replay-from-ClickHouse and the story page. */
  loadTimeline: (rows, runConfig = null) => {
    get().resetRun(rows[0]?.run_id ?? rows[0]?.runId ?? null, runConfig, 'replay');
    for (const r of rows) {
      get().ingestTick({
        runId: r.run_id ?? r.runId,
        t: Number(r.t),
        phase: r.phase || 'load',
        rps: Number(r.rps) || 0,
        errors: Number(r.errors) || 0,
        p50: Number(r.p50) || 0,
        p95: Number(r.p95) || 0,
        p99: Number(r.p99) || 0,
        containers: Number(r.containers) || 0,
        concurrency: Number(r.concurrency) || 0,
        predicted: r.predicted == null ? null : Number(r.predicted),
        instances: [],
        workers: Number(r.workers) || 0,
        costUsd: Number(r.costUsd) || 0,
      });
    }
  },
}));

/** Non-reactive read, for animation callbacks that must not trigger renders. */
export const readStore = () => useStore.getState();
