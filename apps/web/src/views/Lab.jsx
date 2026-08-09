import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import '../styles/lab.css';

/**
 * The lab: capacity envelope, A/B comparison, run permalinks.
 *
 * Scope note: suites are started here but their progress is read by polling
 * `GET /api/suites/:id`-equivalent data through the run history rather than a
 * live subscription — the scheduler broadcasts `suite.progress` over the same
 * bus everything else uses, so wiring a live progress bar is a follow-up, not
 * a redesign. What's here is real and functional: it reads the latest
 * completed envelope sweep, and it diffs any two runs by id.
 */
export default function Lab() {
  const [envelope, setEnvelope] = useState(null);
  const [runs, setRuns] = useState([]);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [compare, setCompare] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.envelope().then(setEnvelope).catch(() => {});
    api.listRuns(50).then(setRuns).catch(() => {});
  }, []);

  const runCompare = async () => {
    setError(null);
    if (!a || !b) { setError('pick two runs'); return; }
    try { setCompare(await api.compare(a, b)); } catch (err) { setError(err.message); }
  };

  const rows = envelope?.result?.envelope || [];

  return (
    <div className="page lab">
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
