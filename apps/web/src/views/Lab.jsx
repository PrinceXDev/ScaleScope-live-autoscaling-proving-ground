import { useEffect, useRef, useState } from 'react';
import { api, openStream } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import OracleLearningPanel from '../components/OracleLearningPanel.jsx';
import '../styles/console.css'; // shared .stat-row / .stat-tile / .field-hint used by StatTile
import '../styles/lab.css';

const SUITE_LABEL = { manual: 'manual suite', knee: 'knee search', envelope: 'capacity envelope', regression: 'regression suite' };

/**
 * The lab: capacity envelope, A/B comparison, run permalinks.
 *
 * Live suite progress rides the same `suite.progress` bus event every other
 * view already consumes via `openStream` — the scheduler broadcasts it on
 * `UI.BROADCAST` at suite start, after every step, and on completion. The
 * payload never carries a total step count (the scheduler doesn't know one
 * up front for a knee search, whose length depends on where the knee turns
 * out to be), so this renders as a live step counter and a pulsing bar rather
 * than a determinate percentage — an honest reflection of what's knowable at
 * suite-start time, not a missing feature.
 */
export default function Lab() {
  const suiteProgress = useStore((s) => s.suiteProgress);
  const [envelope, setEnvelope] = useState(null);
  const [runs, setRuns] = useState([]);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [compare, setCompare] = useState(null);
  const [error, setError] = useState(null);
  const closeRef = useRef(null);

  useEffect(() => {
    api.envelope().then(setEnvelope).catch(() => {});
    api.listRuns(50).then(setRuns).catch(() => {});
  }, []);

  useEffect(() => {
    closeRef.current = openStream((event, data) => {
      if (event !== 'suite.progress') return;
      useStore.getState().setSuiteProgress(data);
      if (data.status && data.status !== 'running') {
        // A suite that just finished may have produced a new envelope sweep -
        // refresh so the table below updates without a manual reload.
        api.envelope().then(setEnvelope).catch(() => {});
      }
    });
    return () => closeRef.current?.();
  }, []);

  const runCompare = async () => {
    setError(null);
    if (!a || !b) { setError('pick two runs'); return; }
    try { setCompare(await api.compare(a, b)); } catch (err) { setError(err.message); }
  };

  const rows = envelope?.result?.envelope || [];

  return (
    <div className="page lab">
      {suiteProgress && <SuiteProgressPanel progress={suiteProgress} />}

      <OracleLearningPanel />

      <section className="panel">
        <header className="panel-head"><span className="panel-title">Capacity envelope</span></header>
        <div className="panel-body">
          {rows.length === 0 && (
            <p className="field-hint">
              No completed envelope sweep yet. Trigger one from the scheduler
              (<code>SUITE.START</code> with <code>kind: 'envelope'</code>) — it drives a short,
              settled probe per container count and reports sustainable throughput and
              linearity once it finishes.
            </p>
          )}
          {rows.length > 0 && (
            <table className="lab-table">
              <thead><tr><th>containers</th><th>sustainable req/s</th><th>req/s per container</th><th>p95</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.containers}>
                    <td>{r.containers}</td>
                    <td>{Math.round(r.sustainableRps)}</td>
                    <td>{r.rpsPerContainer.toFixed(1)}</td>
                    <td>{Math.round(r.p95)}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {envelope?.result?.linearity != null && (
            <p className="field-hint">
              Linearity score: <strong>{envelope.result.linearity}</strong> — 1.0 is perfectly
              linear scaling; below that is diminishing returns per container.
            </p>
          )}
        </div>
      </section>

      <section className="panel">
        <header className="panel-head"><span className="panel-title">Compare two runs</span></header>
        <div className="panel-body">
          <div className="lab-compare-pickers">
            <select value={a} onChange={(e) => setA(e.target.value)}>
              <option value="">run A…</option>
              {runs.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.id.slice(0, 8)}</option>)}
            </select>
            <select value={b} onChange={(e) => setB(e.target.value)}>
              <option value="">run B…</option>
              {runs.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.id.slice(0, 8)}</option>)}
            </select>
            <button className="btn btn-primary" type="button" onClick={runCompare}>compare</button>
          </div>
          {error && <p className="run-controls-error">{error}</p>}
          {compare && (
            <div className="lab-compare-result">
              <table className="lab-table">
                <thead><tr><th>field</th><th>A</th><th>B</th></tr></thead>
                <tbody>
                  {compare.diff.map((d) => <tr key={d.field}><td>{d.field}</td><td>{String(d.a)}</td><td>{String(d.b)}</td></tr>)}
                  {compare.diff.length === 0 && <tr><td colSpan={3}>no config differences</td></tr>}
                </tbody>
              </table>
              <ul className="lab-deltas">
                <li>peak containers: {fmtDelta(compare.deltas.peakContainers)}</li>
                <li>peak req/s: {fmtDelta(compare.deltas.peakRps)}</li>
                <li>peak p95: {fmtDelta(compare.deltas.peakP95Ms)}ms</li>
                <li>time to recover: {fmtDelta(compare.deltas.timeToRecoverS)}s</li>
                <li>estimated cost: {fmtDelta(compare.deltas.estCostUsd, 4)} usd</li>
              </ul>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function fmtDelta(v, decimals = 0) {
  if (v == null || Number.isNaN(v)) return '—';
  const n = Number(v.toFixed(decimals));
  return n > 0 ? `+${n}` : String(n);
}

/**
 * Live suite progress. `progress.status` is 'running' for every broadcast up
 * to the last one, which carries whatever terminal status the scheduler
 * computed ('completed' | 'aborted_budget' | 'aborted' | 'failed'). Terminal
 * states render for a beat so the outcome is legible, then the panel is left
 * in place (not auto-dismissed) — a suite that just failed is exactly the
 * moment someone doesn't want the evidence disappearing on its own.
 */
function SuiteProgressPanel({ progress }) {
  const running = progress.status === 'running';
  const label = SUITE_LABEL[progress.kind] || progress.kind;
  const stepSummary = progress.stepResult?.summary;

  return (
    <section className={`panel suite-progress suite-progress--${running ? 'running' : progress.status}`}>
      <header className="panel-head">
        <span className="panel-title">{label}</span>
        <span className={`suite-status-pill suite-status-pill--${running ? 'running' : progress.status}`}>
          {running ? 'running' : progress.status.replace(/_/g, ' ')}
        </span>
      </header>
      <div className="panel-body">
        <div className="suite-progress-bar" role="progressbar" aria-valuetext={`step ${progress.step}`}>
          <div className={`suite-progress-fill suite-progress-fill--${running ? 'indeterminate' : 'done'}`} />
        </div>
        <div className="suite-progress-meta">
          <span>step {progress.step}</span>
          {stepSummary && (
            <span className="suite-progress-step-summary">
              {stepSummary.peakContainers != null && `peak ${stepSummary.peakContainers} containers`}
              {stepSummary.peakRps != null && ` · ${Math.round(stepSummary.peakRps)} req/s`}
            </span>
          )}
          {!running && progress.result?.error && (
            <span className="suite-progress-error">{progress.result.error}</span>
          )}
        </div>
      </div>
    </section>
  );
}
