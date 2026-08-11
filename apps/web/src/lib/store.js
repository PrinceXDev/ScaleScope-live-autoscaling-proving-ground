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

const scoreBet = (bet, actual) => {
  const absError = Math.abs(actual - bet.predicted);
  return { ...bet, actual, absError, hit: absError <= 1 };
};

const applyResolution = (s, resolved) => {
  const n = s.betAccuracy.n + 1;
  const mae = s.betAccuracy.mae + (resolved.absError - s.betAccuracy.mae) / n;
  const hits = Math.round(s.betAccuracy.hitRate * s.betAccuracy.n) + (resolved.hit ? 1 : 0);
  return {
    betHistory: [resolved, ...s.betHistory].slice(0, 50),
    betAccuracy: { n, mae, hitRate: hits / n },
  };
};

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
  findingEvents: [],         // [{ t, targetKey, predicted, actual, absError, horizonS }]
  instances: new Map(),      // id -> { id, firstT, lastT, requests, peakP95 }
  workers: new Set(),

  // ---- the oracle's bet: one committed forecast, latched at t, due at t+horizonS ----
  pendingBet: null,          // { t, dueT, horizonS, predicted, confidence } | null
  betHistory: [],            // resolved bets, newest first: [{ ...pendingBet, actual, absError, hit }]
  betAccuracy: { n: 0, mae: 0, hitRate: 0 }, // hit = absError <= 1

  peak: { containers: 0, rps: 0, p95: 0 },
  timeToRecoverS: null,
  costUsd: 0,
  scorecard: null,           // set by `completeRun` once the run finishes -- see packages/control/src/scorecard.js

  // ---- catalogue ----
  runs: [],
  topology: null,
  budget: null,
  suiteProgress: null,       // latest { suiteId, kind, status, step, stepResult?, result? } or null

  setConnected: (connected) => set({ connected }),
  setSource: (source) => set({ source }),
  setTopology: (topology) => set({ topology }),
  setBudget: (budget) => set({ budget }),
  setRuns: (runs) => set({ runs }),
  setSuiteProgress: (p) => set({ suiteProgress: p }),

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
    findingEvents: [],
    instances: new Map(),
    pendingBet: null,
    betHistory: [],
    betAccuracy: { n: 0, mae: 0, hitRate: 0 },
    peak: { containers: 0, rps: 0, p95: 0 },
    timeToRecoverS: null,
    costUsd: 0,
    scorecard: null,
  }),

  /**
   * Latch a new committed bet from a `prediction` SSE event. Only one bet is
   * live at a time -- if a prior one never reached its due tick (run ended,
   * dropped frame) it is discarded unresolved rather than scored, since an
   * unresolved bet has no `actual` to compare against.
   */
  pushPrediction: (p) => set((s) => {
    if (s.runId && p.runId && p.runId !== s.runId) return s;
    // A new forecast can land on the exact tick a prior bet was due (the oracle
    // reads the fleet and re-predicts every tick). Score the outgoing bet
    // against the tick that just arrived before it's replaced, rather than
    // silently discarding it unresolved.
    const outgoing = s.pendingBet && p.t >= s.pendingBet.dueT
      ? scoreBet(s.pendingBet, s.frame?.containers ?? 0)
      : null;
    return {
      pendingBet: { t: p.t, dueT: p.t + p.horizonS, horizonS: p.horizonS, predicted: p.predicted, confidence: p.confidence },
      ...(outgoing ? applyResolution(s, outgoing) : {}),
    };
  }),

  /**
   * The single ingest path. Appends to the flat typed-ish arrays uPlot wants
   * (parallel arrays, not array-of-objects) and updates derived aggregates in
   * the same pass so no component ever recomputes a peak from the full series.
   */
  ingestTick: (f) => set((s) => {
    if (s.runId && f.runId && f.runId !== s.runId) return s;

    // Resolve the pending bet once reality reaches the tick it targeted.
    let pendingBet = s.pendingBet;
    let { betHistory, betAccuracy } = s;
    if (pendingBet && f.t >= pendingBet.dueT) {
      const resolved = scoreBet(pendingBet, f.containers ?? 0);
      ({ betHistory, betAccuracy } = applyResolution(s, resolved));
      pendingBet = null;
    }

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
      pendingBet,
      betHistory,
      betAccuracy,
      peak: {
        containers: Math.max(s.peak.containers, f.containers || 0),
        rps: Math.max(s.peak.rps, f.rps || 0),
        p95: Math.max(s.peak.p95, f.p95 || 0),
      },
    };
  }),

  pushScale: (e) => set((s) => ({ scaleEvents: [...s.scaleEvents, e] })),
  pushChaos: (e) => set((s) => ({ chaosEvents: [...s.chaosEvents, e] })),
  pushFinding: (e) => set((s) => ({ findingEvents: [...s.findingEvents, e] })),
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
