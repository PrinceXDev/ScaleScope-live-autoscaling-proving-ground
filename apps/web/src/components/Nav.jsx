import { useEffect, useRef } from 'react';
import { href } from '../lib/router.js';
import { useStore } from '../lib/store.js';
import { gsap } from '../motion/gsap.js';

const LINKS = [
  { path: '/',        id: 'story',   label: 'Story' },
  { path: '/console', id: 'console', label: 'Console' },
  { path: '/lab',     id: 'lab',     label: 'Lab' },
];

export default function Nav({ route }) {
  const status = useStore((s) => s.status);
  const phase = useStore((s) => s.phase);
  const budget = useStore((s) => s.budget);
  const connected = useStore((s) => s.connected);
  const dotRef = useRef(null);

  // The live dot breathes only while a run is in flight. A static indicator
  // reads as decoration; one that starts moving the moment load begins reads as
  // an instrument, and it costs four lines.
  useEffect(() => {
    const el = dotRef.current;
    if (!el) return;
    gsap.killTweensOf(el);
    if (status === 'running') {
      gsap.fromTo(el,
        { scale: 1, opacity: 1 },
        { scale: 1.9, opacity: 0.15, duration: 1, repeat: -1, yoyo: true, ease: 'sine.inOut' });
    } else {
      gsap.to(el, { scale: 1, opacity: 1, duration: 0.3 });
    }
  }, [status]);

  const live = status === 'running';

  return (
    <nav className="nav">
      <a className="nav-brand" href={href('/')}>
        <span className="nav-mark" aria-hidden="true" />
        <span>ScaleScope</span>
      </a>

      <div className="nav-links">
        {LINKS.map((l) => (
          <a
            key={l.id}
            href={href(l.path)}
            className={`nav-link${route.id === l.id || (route.id === 'replay' && l.id === 'console') ? ' is-active' : ''}`}
          >
            {l.label}
          </a>
        ))}
      </div>

      <div className="nav-status">
        {budget && (
          <span className="nav-budget mono" title="Runs remaining this hour. A public start button on a fixed credit balance needs a server-side ceiling, not a polite request.">
            {budget.remaining}/{budget.limit} runs
          </span>
        )}
        <span className={`nav-pill${live ? ' is-live' : ''}`}>
          <i ref={dotRef} className="nav-dot" />
          <span className="mono">
            {live ? (phase === 'cooldown' ? 'COOLDOWN' : 'LIVE') : connected ? 'IDLE' : 'OFFLINE'}
          </span>
        </span>
      </div>
    </nav>
  );
}
