/**
 * A running log of everything annotated on the chart: scale changes, SLO
 * breaches and recoveries, chaos injections. Kept as plain text rather than
 * icons-and-color soup, because the thing a judge actually reads during a demo
 * is the sentence, not the decoration around it.
 */
export default function EventTicker({ scaleEvents, sloEvents, chaosEvents }) {
  const events = [
    ...scaleEvents.map((e) => ({
      t: e.t, kind: e.to > e.from ? 'scale-up' : 'scale-down',
      text: `containers ${e.from} → ${e.to}`,
    })),
    ...sloEvents.map((e) => ({
      t: e.t, kind: e.state === 'breached' ? 'breach' : 'recover',
      text: e.state === 'breached' ? 'SLO breached' : `SLO recovered — took ${Math.round(e.timeToRecoverS ?? 0)}s`,
    })),
    ...chaosEvents.map((e) => ({
      t: e.at ? Math.round(e.at / 1000) : e.t, kind: 'chaos',
      text: e.error ? `chaos ${e.kind} failed: ${e.error}` : `chaos: ${e.kind}${e.detail?.jitterMs ? ` (+${e.detail.jitterMs}ms)` : ''}`,
    })),
  ].sort((a, b) => (b.t ?? 0) - (a.t ?? 0)).slice(0, 40);

  return (
    <ul className="event-ticker">
      {events.length === 0 && <li className="event-ticker-empty mono">no annotations yet</li>}
      {events.map((e, i) => (
        <li key={i} className={`event-row event-${e.kind}`}>
          <span className="event-t mono">t+{e.t ?? 0}s</span>
          <span className="event-text">{e.text}</span>
        </li>
      ))}
    </ul>
  );
}
