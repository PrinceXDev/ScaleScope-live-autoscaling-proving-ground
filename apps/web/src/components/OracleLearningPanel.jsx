import { useEffect, useState } from 'react';
import { oracleApi } from '../lib/api.js';
import StatTile from './StatTile.jsx';
import AccuracyTrend from './AccuracyTrend.jsx';

const POLL_MS = 5000;
const MIN_FRAMES_TO_PERSIST = 20; // mirrors apps/oracle/src/persistence.js's own guardrail

/**
 * Makes the twin's own learning visible.
 *
 * Every run, the oracle re-estimates capacityPerContainer / scaleUpLagS /
 * scaleDownLagS for whatever (target, rounds) key just ran, and persists the
 * update once a run has produced enough frames to trust (oracle's own
 * MIN_FRAMES_TO_PERSIST guardrail). None of that was visible anywhere in the
 * product before this panel — /params and /accuracy existed and were correct,
 * they just had no UI. This polls both on a plain interval rather than a bus
 * subscription: the oracle doesn't broadcast a "training finished" event by
 * design (see apps/oracle/src/index.js), so polling is the actual shape of
 * the data, not a shortcut.
 */
export default function OracleLearningPanel() {
  const [params, setParams] = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      Promise.all([oracleApi.params(), oracleApi.accuracy(null, 200)])
        .then(([p, a]) => { if (!cancelled) { setParams(p); setAccuracy(a); setError(null); } })
        .catch((err) => { if (!cancelled) setError(err.message); });
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (error) {
    return (
      <section className="panel oracle-panel">
        <header className="panel-head"><span className="panel-title">The oracle is learning</span></header>
        <div className="panel-body">
          <p className="field-hint">Oracle unreachable ({error}) — check <code>oracleUrl</code> in <code>config.json</code>.</p>
        </div>
      </section>
    );
  }

  if (!params) return null;

  const persisted = [...(params.persisted || [])].sort((a, b) => (b.samples || 0) - (a.samples || 0));
  const lead = persisted[0] || null;
  const totalSamples = persisted.reduce((sum, p) => sum + (p.samples || 0), 0);
  const confidence = confidenceLabel(lead);

  return (
    <section className="panel oracle-panel">
      <header className="panel-head">
        <span className="panel-title">The oracle is learning</span>
        <span className={`confidence-pill confidence-pill--${confidence.level}`}>{confidence.text}</span>
      </header>
      <div className="panel-body">
        <p className="field-hint oracle-blurb">
          Online parameter estimation, not a trained model — every completed run with at least
          {' '}{MIN_FRAMES_TO_PERSIST} frames updates the twin's belief about how <em>this specific</em>
          {' '}deployment scales. This is that belief, and how wrong it's been lately.
        </p>

        <div className="stat-row oracle-stat-row">
          <StatTile
            label="targets tracked"
            value={persisted.length}
            color="var(--predicted)"
          />
          <StatTile
            label="total samples"
            value={totalSamples}
            color="var(--predicted)"
            note={lead ? `${lead.samples} on leading target` : undefined}
          />
          <StatTile
            label="mean abs error"
            value={accuracy?.meanAbsErrorContainers ?? null}
            unit="containers"
            decimals={2}
            color={errorColor(accuracy?.meanAbsErrorContainers)}
            note={`${Math.round((accuracy?.exactRate ?? 0) * 100)}% exact`}
          />
          <StatTile
            label="live twins"
            value={params.live?.length ?? 0}
            color="var(--good)"
            note="tracking an active run"
          />
        </div>

        {lead && (
          <div className="oracle-belief">
            <div className="oracle-belief-key mono">{lead.targetKey}</div>
            <div className="oracle-belief-row">
              <span>capacity/container <b className="num">{fmtParam(lead.params?.capacityPerContainer)}</b> req/s</span>
              <span>scale-up lag <b className="num">{fmtParam(lead.params?.scaleUpLagS)}</b> s</span>
              <span>scale-down lag <b className="num">{fmtParam(lead.params?.scaleDownLagS)}</b> s</span>
            </div>
          </div>
        )}

        <div className="oracle-trend-head">
          <span>prediction error, last {accuracy?.pairs?.length ?? 0} forecasts</span>
        </div>
        <AccuracyTrend pairs={accuracy?.pairs || []} />
      </div>
    </section>
  );
}

function fmtParam(v) {
  return typeof v === 'number' ? v.toFixed(1) : '—';
}

function errorColor(err) {
  if (err == null) return 'var(--fg-dim)';
  if (err < 0.5) return 'var(--good)';
  if (err < 1.5) return 'var(--latency)';
  return 'var(--breach)';
}

function confidenceLabel(lead) {
  if (!lead || (lead.samples || 0) === 0) return { level: 'calibrating', text: 'calibrating' };
  if (lead.samples < 5) return { level: 'calibrating', text: `calibrating · ${lead.samples} sample${lead.samples === 1 ? '' : 's'}` };
  return { level: 'trained', text: `trained · ${lead.samples} samples` };
}
