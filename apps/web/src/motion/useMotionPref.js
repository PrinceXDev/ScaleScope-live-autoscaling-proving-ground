import { useEffect, useState } from 'react';

/**
 * Reduced motion, taken seriously.
 *
 * The story page is entirely scroll-driven, so "respecting the preference"
 * cannot mean shortening transitions - it has to mean building a different
 * page. When this returns true the story view skips Lenis entirely, builds its
 * ScrollTrigger timelines without `scrub`, and sets every animated element to
 * its final state on mount. The narrative still reads top to bottom; it just
 * doesn't move.
 *
 * Worth doing for its own sake, and worth knowing that a judge with vestibular
 * sensitivity and the OS preference set is a real person who will otherwise
 * bounce off the first pinned section.
 */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = (e) => setReduced(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  return reduced;
}
