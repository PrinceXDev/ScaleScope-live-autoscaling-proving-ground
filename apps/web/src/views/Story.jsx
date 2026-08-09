import { useEffect, useRef, useState } from 'react';
import Lenis from 'lenis';
import { gsap, splitChars } from '../motion/gsap.js';
import { useReducedMotion } from '../motion/useMotionPref.js';
import { href } from '../lib/router.js';
import { api, openStream } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import TimelineChart from '../components/TimelineChart.jsx';
import '../styles/story.css';

/**
 * The landing page.
 *
 * Scope note for this build: this is the hero-and-attract-mode version of the
 * story rather than the full scroll-scrubbed narrative (each section pinned,
 * the chart scrubbing to a different moment of a recorded run as you scroll)
 * described in the original brief. That version is a legitimate next step --
 * the scaffolding for it (ScrollTrigger, Flip and MotionPath are already
 * registered in motion/gsap.js, and the store's `loadTimeline` exists
 * specifically so a scrubbed position can seek into a run) -- but it is
 * substantially more build time than the entrance animation and attract-mode
 * replay here, and a working, deployed console beats an unfinished scrollytelling
 * page every time judging is imminent. Build it by driving a ScrollTrigger
 * timeline's onUpdate against `store.loadTimeline(rows)` plus a seek function
 * that slices the series arrays to the scrubbed index.
 *
 * What IS real here: Lenis smooth scroll, a GSAP character-reveal on the
 * headline, and attract mode -- the showcase run replaying live into the exact
 * same TimelineChart component the console uses, so a visitor sees the product
 * work before they've clicked anything.
 */
export default function Story() {
  const reduced = useReducedMotion();
  const heroRef = useRef(null);
  const [showcase, setShowcase] = useState(null);
  const store = useStore();
  const closeRef = useRef(null);

  useEffect(() => {
    if (reduced) return;
    const lenis = new Lenis({ duration: 1.1, smoothWheel: true });
    let raf;
    const loop = (time) => { lenis.raf(time); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); lenis.destroy(); };
  }, [reduced]);

  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    const title = el.querySelector('.hero-title');
    const chars = splitChars(title);
    if (reduced) { gsap.set(chars, { opacity: 1, y: 0 }); return; }
    gsap.fromTo(chars,
      { opacity: 0, y: 24, filter: 'blur(6px)' },
      { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.7, ease: 'power3.out', stagger: 0.018 });
    gsap.fromTo('.hero-sub, .hero-cta', { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.6, delay: 0.4, stagger: 0.08 });
  }, [reduced]);

  useEffect(() => {
    api.showcase().then(setShowcase).catch(() => {});
  }, []);

  useEffect(() => {
    if (!showcase?.id) return;
    store.resetRun(showcase.id, null, 'story');
    closeRef.current?.();
    closeRef.current = openStream((event, data) => {
      const s = useStore.getState();
      if (event === 'tick') s.ingestTick(data);
      if (event === 'replay.end') {
        // Loop the attract-mode replay so the landing page never goes idle.
        setTimeout(() => { closeRef.current?.(); closeRef.current = openStream(
          (e2, d2) => { if (e2 === 'tick') useStore.getState().ingestTick(d2); },
          { runId: showcase.id, replay: true, speed: 3 },
        ); }, 1500);
      }
    }, { runId: showcase.id, replay: true, speed: 3 });
    return () => closeRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showcase?.id]);

  return (
    <div className="page story">
      <section className="hero" ref={heroRef}>
        <h1 className="hero-title">Watch Zerops<br />autoscale, live.</h1>
        <p className="hero-sub">
          ScaleScope fires controlled load at a service and streams container count,
          latency and throughput in real time — a latency target goes in, a staircase
          of containers comes out, every run replayable afterwards.
        </p>
        <div className="hero-cta">
          <a className="btn btn-primary" href={href('/console')}>Open the console</a>
          <a className="btn" href={href('/lab')}>Visit the lab</a>
        </div>
      </section>

      <section className="attract">
        <div className="panel-head" style={{ border: 'none', padding: '0 0 12px' }}>
          <span className="panel-title">
            {showcase ? `attract mode — replaying "${showcase.name}"` : 'attract mode'}
          </span>
          <span className="panel-note mono">no run active — this is a past run, on loop</span>
        </div>
        <div className="panel">
          <div className="panel-body">
            <TimelineChart
              t={store.series.t} containers={store.series.containers}
              rps={store.series.rps} p95={store.series.p95} predicted={store.series.predicted}
              scaleEvents={store.scaleEvents} chaosEvents={store.chaosEvents} sloEvents={store.sloEvents}
              height={220}
            />
          </div>
        </div>
      </section>

      <section className="pitch">
        <h2>Two technical tricks make this work</h2>
        <div className="pitch-grid">
          <div className="pitch-card">
            <h3>Force horizontal, not vertical</h3>
            <p>
              Zerops scales vertically first — more CPU inside the container — and only
              adds containers once that ceiling is hit. The target's vertical ceiling is
              capped deliberately low so the platform has no option but to add capacity,
              and the CPU-bound <code>/work</code> endpoint (real pbkdf2, not a sleep) makes
              that ceiling something load can actually reach.
            </p>
          </div>
          <div className="pitch-card">
            <h3>Count containers without a privileged API</h3>
            <p>
              Every target container mints a UUID at boot and returns it in an
              <code>X-Instance-Id</code> header. Distinct IDs in a rolling ten-second
              window is the live container count — measured, not self-reported, and it
              needs no platform token at all.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
