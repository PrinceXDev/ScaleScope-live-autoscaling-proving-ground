import { useEffect, useRef } from 'react';
import { tweenNumber } from '../motion/gsap.js';
import Explain from './Explain.jsx';

/**
 * A single readout, tweened by GSAP rather than re-rendered by React.
 *
 * At one tick per second this would be fine either way, but the container
 * count and the autopilot's concurrency figure both change several times a
 * second during a transition, and re-rendering a React tree at that rate while
 * uPlot is also repainting is how a live console starts dropping frames right
 * when the container count is doing the thing you built the product to show.
 * Handing the DOM node to GSAP and writing textContent directly sidesteps
 * React for this one hot path.
 *
 * `explain`, if given, is the tile's whole reason for existing to a visitor
 * who didn't build this: a number with no stated method is a claim asking to
 * be trusted, and a number with its method one hover away is a measurement.
 * That's the same rule the report card and the oracle's bet already follow
 * (see docs/features.md) -- this just extends it to every stat on the page,
 * not only the two features that shipped with the idea already applied.
 */
export default function StatTile({ label, value, unit, color, note, decimals = 0, explain }) {
  const ref = useRef(null);
  const prev = useRef(value);

  useEffect(() => {
    if (ref.current == null) return;
    if (typeof value !== 'number') {
      ref.current.textContent = value ?? '—';
      return;
    }
    tweenNumber(ref.current, prev.current ?? value, value, { decimals });
    prev.current = value;
  }, [value, decimals]);

  return (
    <div className="stat-tile" style={color ? { '--tile-color': color } : undefined}>
      <div className="stat-label-row">
        <div className="stat-label">{label}</div>
        {explain && <Explain label={label}>{explain}</Explain>}
      </div>
      <div className="stat-value">
        <span className="num" ref={ref}>{typeof value === 'number' ? value.toFixed(decimals) : value ?? '—'}</span>
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}
