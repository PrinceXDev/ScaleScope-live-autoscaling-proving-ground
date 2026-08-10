import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store.js';
import { sendPacket, onTopologyEvent } from '../motion/gsap.js';

/**
 * The architecture panel, animated.
 *
 * `/api/topology` already serves the real subject map (SUBJECT_TABLE) and
 * real health checks — this component is the part that was always missing:
 * something that draws it. Nodes are laid out by hand in a fixed coordinate
 * space (percentages of the panel, not real physical distance — there's no
 * meaningful "distance" between two NATS subjects) grouped the way the
 * architecture actually is: control plane top, load fleet left, the service
 * under test centre-right, data tier bottom, dashboard standing apart since
 * it isn't a bus participant at all.
 *
 * Packets travelling the wire are a *representation*, not a literal replay
 * of what the browser observed. Every SSE event physically arrives via one
 * relay hop — collector/oracle/chaos/scheduler → gateway → this browser —
 * because that's the one hop `ui.broadcast` + the SSE bridge actually is.
 * Animating literally would mean every packet ends at "gateway" and the
 * diagram would say nothing about who talks to whom upstream of that. So
 * each SSE event is mapped instead to the SUBJECT_TABLE edge it's evidence
 * of (a `tick` event proves collector produced a frame, so it animates
 * along collector→gateway; a `finding` proves oracle detected one, so it
 * animates oracle→gateway) — inferred, not observed, and said so here so
 * nobody mistakes this for more than it is.
 */

const NODE_POS = {
  web:       { x: 8,  y: 8,  label: 'web' },
  gateway:   { x: 50, y: 10, label: 'gateway' },
  scheduler: { x: 82, y: 8,  label: 'scheduler' },
  oracle:    { x: 82, y: 32, label: 'oracle' },
  chaos:     { x: 82, y: 56, label: 'chaos' },
  worker:    { x: 18, y: 34, label: 'worker' },
  target:    { x: 42, y: 56, label: 'target' },
  collector: { x: 66, y: 34, label: 'collector' },
  nats:      { x: 50, y: 56, label: 'nats' },
  db:        { x: 18, y: 82, label: 'db' },
  cache:     { x: 42, y: 82, label: 'cache' },
  metrics:   { x: 66, y: 82, label: 'metrics' },
};

/** SSE event name -> the SUBJECT_TABLE edge it's evidence of, plus a colour token. */
const EVENT_EDGE = {
  tick:            { from: 'collector', to: 'gateway', color: 'var(--throughput)' },
  scaled:          { from: 'collector', to: 'gateway', color: 'var(--containers)' },
  slo:             { from: 'collector', to: 'gateway', color: 'var(--breach)' },
  watermark:       { from: 'collector', to: 'gateway', color: 'var(--fg-dim)' },
  prediction:      { from: 'oracle', to: 'gateway', color: 'var(--predicted)' },
  finding:         { from: 'oracle', to: 'gateway', color: 'var(--finding)' },
  'suite.progress':{ from: 'scheduler', to: 'gateway', color: 'var(--fg-dim)' },
  'worker.hello':  { from: 'worker', to: 'gateway', color: 'var(--fg-faint)' },
  // chaos rides one SSE name for two opposite hops -- a command payload has
  // `kind`+`detail` with no `at`-only report shape; an effect report always
  // carries `at`. Resolved per-event in fireForEvent, not here.
};

const EDGE_COOLDOWN_MS = 220;
const MAX_PACKETS_PER_EDGE = 3;

export default function TopologyPanel() {
  const topology = useStore((s) => s.topology);
  const setTopology = useStore((s) => s.setTopology);
  const containerRef = useRef(null);
  const nodeRefs = useRef(new Map());
  const pathRefs = useRef(new Map());
  const lastFired = useRef(new Map());
  const [, forceLayout] = useState(0);

  // Health is fetched once at the app shell; refresh it here too so the panel
  // that actually displays it stays live without depending on another view
  // having been visited first.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      import('../lib/api.js').then(({ api }) => {
        api.topology().then((t) => { if (!cancelled) setTopology(t); }).catch(() => {});
      });
    };
    poll();
    const id = setInterval(poll, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [setTopology]);

  // Recompute edge <path> geometry whenever the panel resizes -- never inside
  // the animation hot path, which only ever reads the cached path elements.
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => forceLayout((n) => n + 1));
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => onTopologyEvent(fireForEvent), []);

  function fireForEvent(event, data) {
    let edge = EVENT_EDGE[event];
    if (event === 'chaos') {
      // Both directions broadcast under the same 'chaos' name, so the shape
      // of the payload is the only way to tell them apart. The command the
      // gateway issues (runs.js's POST /chaos route, and the auto-chaos
      // loop) always carries a top-level durationS; neither of chaos's own
      // reports (success or error) ever include that field -- durationS only
      // survives inside detail.ttlS on the effect side. That asymmetry, not
      // `at` (both sides stamp one), is what's checked here.
      edge = data?.durationS != null
        ? { from: 'gateway', to: 'chaos', color: 'var(--finding)' }
        : { from: 'chaos', to: 'gateway', color: 'var(--breach)' };
    }
    if (!edge) return;

    const edgeId = `${edge.from}->${edge.to}`;
    const now = Date.now();
    const last = lastFired.current.get(edgeId) ?? 0;
    if (now - last < EDGE_COOLDOWN_MS) return;

    const pathEl = pathRefs.current.get(edgeId);
    if (!pathEl) return;
    if (pathEl.parentNode.querySelectorAll('circle.topology-packet').length >= MAX_PACKETS_PER_EDGE) return;

    lastFired.current.set(edgeId, now);
    sendPacket(pathEl, { color: edge.color });
  }

  const services = topology?.services || [];
  const edges = dedupedEdges(topology?.subjects || []);

  return (
    <section className="panel topology-panel">
      <header className="panel-head">
        <span className="panel-title">Architecture, live</span>
        <span className="panel-note mono">{services.filter((s) => s.status === 'up').length}/{services.length} up</span>
      </header>
      <div className="panel-body">
        <p className="field-hint topology-blurb">
          Every box below is a real health check, polled every 10s, not a picture drawn once. Packets
          travel the routes the event log actually proves happened — an oracle finding lights up
          oracle→gateway, a scale event lights up collector→gateway.
        </p>
        <div className="topology-canvas" ref={containerRef}>
          <svg className="topology-edges" preserveAspectRatio="none">
            {edges.map(({ id, from, to }) => (
              <EdgeLine key={id} id={id} from={NODE_POS[from]} to={NODE_POS[to]} pathRefs={pathRefs} />
            ))}
          </svg>
          {Object.entries(NODE_POS).map(([id, pos]) => {
            const svc = services.find((s) => s.id === id);
            return (
              <TopologyNode
                key={id}
                id={id}
                pos={pos}
                service={svc}
                setRef={(el) => { if (el) nodeRefs.current.set(id, el); }}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}

function EdgeLine({ id, from, to, pathRefs }) {
  if (!from || !to) return null;
  // A slight curve, not a straight line -- several edges share endpoints
  // (collector->gateway carries four different event kinds), and a shared
  // straight segment would make simultaneous packets on different edges
  // visually indistinguishable from one packet.
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const bow = 3; // percentage-point perpendicular offset
  const cx = mx + (-dy / len) * bow;
  const cy = my + (dx / len) * bow;

  return (
    <path
      ref={(el) => { if (el) pathRefs.current.set(id, el); }}
      className="topology-edge"
      d={`M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`}
      vectorEffect="non-scaling-stroke"
    />
  );
}

function TopologyNode({ id, pos, service, setRef }) {
  const status = service?.status ?? 'unknown';
  return (
    <div
      ref={setRef}
      className={`topology-node topology-node--${status}`}
      style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
      title={service?.role || id}
    >
      <span className="topology-node-dot" />
      <span className="topology-node-label mono">{pos.label}</span>
    </div>
  );
}

/** Collapse SUBJECT_TABLE rows to unique (from,to) pairs that resolve to real nodes on this diagram. */
function dedupedEdges(subjects) {
  const seen = new Set();
  const out = [];
  for (const s of subjects) {
    const pairs = s.to === 'gateway+collector' ? [['worker', 'gateway'], ['worker', 'collector']] : [[s.from, s.to]];
    for (const [from, to] of pairs) {
      if (!(from in NODE_POS) || !(to in NODE_POS)) continue;
      const id = `${from}->${to}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, from, to });
    }
  }
  return out;
}
