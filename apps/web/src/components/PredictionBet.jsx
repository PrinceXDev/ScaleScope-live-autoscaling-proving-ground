import { useEffect, useState } from 'react';
import StatTile from './StatTile.jsx';

/**
 * The oracle's prediction, staged as a committed bet rather than a line on a
 * chart nobody watches. The moment a `prediction` event arrives, the claim is
 * frozen on screen -- "in 15s: 4 containers" -- with a countdown to when it
 * will be checked. When the tick it targeted actually lands, the real value
 * drops in next to it and the bet is scored. Hit/miss uses the same ±1
 * tolerance as the running accuracy figure below it, so the single bet and
 * the aggregate always agree on what "right" means.
 */
export default function PredictionBet({ pendingBet, betHistory, betAccuracy }) {
  const [now, setNow] = useState(pendingBet?.t ?? 0);

  useEffect(() => {
    if (!pendingBet) return undefined;
    setNow(pendingBet.t);
    const id = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [pendingBet?.t, pendingBet?.dueT]);

  const lastResolved = betHistory[0];
  const remaining = pendingBet ? Math.max(0, pendingBet.dueT - now) : 0;

  return (
    <section className="panel prediction-bet">
      <header className="panel-head">
        <span className="panel-title">The oracle's bet</span>
        <span className="panel-note mono">{betAccuracy.n} scored</span>
      </header>
      <div className="panel-body">
        {pendingBet ? (
          <div className="bet-live">
            <div className="bet-claim">
              <span className="bet-claim-label">in {pendingBet.horizonS}s:</span>
              <span className="bet-claim-value mono">{pendingBet.predicted} containers</span>
            </div>
            <div className="bet-countdown mono">
              {remaining > 0 ? `resolving in ${remaining}s` : 'checking now…'}
            </div>
            <div className="bet-progress">
              <i style={{ width: `${Math.min(100, ((pendingBet.horizonS - remaining) / pendingBet.horizonS) * 100)}%` }} />
            </div>
          </div>
        ) : lastResolved ? (
          <div className={`bet-resolved ${lastResolved.hit ? 'bet-hit' : 'bet-miss'}`}>
            <div className="bet-resolved-row">
              <span className="bet-resolved-label">called</span>
              <span className="bet-resolved-value mono">{lastResolved.predicted}</span>
            </div>
            <div className="bet-resolved-row">
              <span className="bet-resolved-label">landed</span>
              <span className="bet-resolved-value mono">{lastResolved.actual}</span>
            </div>
            <div className="bet-verdict mono">
              {lastResolved.hit ? 'HIT' : 'MISS'} — off by {lastResolved.absError.toFixed(0)}
            </div>
          </div>
        ) : (
          <p className="field-hint">waiting for the oracle's first call…</p>
        )}

        <div className="stat-row bet-accuracy-row">
          <StatTile label="mean abs error" value={betAccuracy.mae} unit="ctr" decimals={2} color="var(--predicted)" />
          <StatTile label="hit rate ±1" value={betAccuracy.n ? betAccuracy.hitRate * 100 : 0} unit="%" decimals={0} color="var(--good)" note={`${betAccuracy.n} bets`} />
        </div>
      </div>
    </section>
  );
}
