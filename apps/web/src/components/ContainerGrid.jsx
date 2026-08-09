import { useLayoutEffect, useRef } from 'react';
import { Flip, gsap } from '../motion/gsap.js';

/**
 * The container count made physical.
 *
 * A number ticking upward is a fact. A row of cards where a new one visibly
 * flies in from nowhere and the others make room is the same fact, staged so a
 * viewer feels the platform respond rather than reads that it did -- which is
 * the entire argument for using FLIP here rather than a plain CSS grid.
 *
 * GSAP Flip works by snapshotting the DOM's current layout, letting React
 * reconcile the new set of cards wherever it wants, then animating from the
 * snapshot to wherever things actually ended up. That ordering -- capture
 * BEFORE the DOM changes, animate AFTER -- is why this is a `useLayoutEffect`
 * pair (capture on the render that is about to change, animate on the one
 * after) rather than a single effect: a single effect fires after the DOM
 * has already updated, and by then the "before" state Flip needs is gone.
 */
export default function ContainerGrid({ instances }) {
  const gridRef = useRef(null);
  const stateRef = useRef(null);
  const idsRef = useRef([]);

  const ids = instances.map((i) => i.id);
  const idsChanged = ids.join(',') !== idsRef.current.join(',');

  // Capture, synchronously, before this render's DOM mutation is painted.
  if (idsChanged && gridRef.current) {
    stateRef.current = Flip.getState(gridRef.current.children);
  }

  useLayoutEffect(() => {
    if (!stateRef.current) { idsRef.current = ids; return; }
    Flip.from(stateRef.current, {
      duration: 0.55,
      ease: 'power3.out',
      absolute: true,
      onEnter: (els) => gsap.fromTo(els, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.4, ease: 'back.out(2)' }),
      onLeave: (els) => gsap.to(els, { opacity: 0, scale: 0.7, duration: 0.3 }),
    });
    stateRef.current = null;
    idsRef.current = ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(',')]);

  return (
    <div className="container-grid" ref={gridRef}>
      {instances.length === 0 && <p className="container-grid-empty mono">no containers observed yet</p>}
      {instances.map((inst) => (
        <div key={inst.id} className="container-card" data-flip-id={inst.id}>
          <div className="container-card-id mono">{inst.id}</div>
          <div className="container-card-req">{inst.requests.toLocaleString()} req</div>
          <div className="container-card-bar">
            <i style={{ width: `${Math.min(100, (inst.peakP95 / 800) * 100)}%` }} />
          </div>
          <div className="container-card-p95 mono">{Math.round(inst.peakP95)}ms</div>
        </div>
      ))}
    </div>
  );
}
