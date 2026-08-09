import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Flip } from 'gsap/Flip';
import { MotionPathPlugin } from 'gsap/MotionPathPlugin';
import { Observer } from 'gsap/Observer';

/**
 * Plugin registration, once, at boot.
 *
 * The four plugins here each do a specific job in this product and none of them
 * is decoration:
 *
 *   ScrollTrigger    drives the story page, where scroll position IS the run
 *                    timeline - scrubbing down the page scrubs through a real
 *                    recorded run second by second.
 *   Flip             animates the container cards when the count changes.
 *                    Containers appearing is the single most important event in
 *                    the product, and FLIP is the only way to make cards
 *                    reflow into a new grid without the layout snapping.
 *   MotionPathPlugin sends packets along the SVG edges of the architecture
 *                    diagram, so the data flow is shown rather than labelled.
 *   Observer         unifies wheel/touch/pointer for the story's section
 *                    snapping without three separate event handlers.
 *
 * lagSmoothing(0) is important with Lenis: GSAP's default lag smoothing will
 * fight a smooth-scroll library during heavy frames and produce a visible
 * stutter exactly when the charts are busiest, which is exactly when someone is
 * recording video.
 */

let registered = false;

export function registerGsap() {
  if (registered) return gsap;
  gsap.registerPlugin(ScrollTrigger, Flip, MotionPathPlugin, Observer);
  gsap.ticker.lagSmoothing(0);
  gsap.defaults({ ease: 'power3.out', duration: 0.6 });
  registered = true;
  return gsap;
}

export { gsap, ScrollTrigger, Flip, MotionPathPlugin, Observer };

/**
 * Animate a numeric readout without re-rendering React on every frame.
 *
 * The container counter updates sixty times a second during a transition. Doing
 * that through React state would re-render the entire console tree sixty times
 * a second while uPlot is also drawing. Instead GSAP tweens a plain object and
 * writes textContent directly - the DOM node is the state.
 */
export function tweenNumber(el, from, to, opts = {}) {
  const obj = { v: from };
  return gsap.to(obj, {
    v: to,
    duration: opts.duration ?? 0.5,
    ease: opts.ease ?? 'power2.out',
    snap: opts.decimals ? undefined : { v: 1 },
    onUpdate() {
      if (!el) return;
      el.textContent = opts.decimals
        ? obj.v.toFixed(opts.decimals)
        : String(Math.round(obj.v));
    },
  });
}

/** Split a string into per-character spans for stagger reveals. */
export function splitChars(el) {
  if (!el || el.dataset.split === '1') return [...(el?.querySelectorAll('.ch') || [])];
  const text = el.textContent;
  el.textContent = '';
  el.dataset.split = '1';
  const nodes = [...text].map((c) => {
    const s = document.createElement('span');
    s.className = 'ch';
    s.textContent = c === ' ' ? ' ' : c;
    s.style.display = 'inline-block';
    s.style.willChange = 'transform, opacity';
    el.appendChild(s);
    return s;
  });
  return nodes;
}
