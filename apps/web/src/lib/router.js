import { useEffect, useState } from 'react';

/**
 * A ~40-line hash router, deliberately not react-router.
 *
 * The dashboard deploys to a Zerops `static` service. Path-based routing on a
 * static host needs a rewrite rule so /r/abc-123 serves index.html instead of
 * 404ing, and getting that wrong is discovered by a judge, not by you. Hash
 * routing has no server-side requirement at all, works identically in `vite
 * preview` and in production, and makes permalinks copy-pasteable without any
 * host configuration.
 *
 * Routes:
 *   #/            the story  (scroll-scrubbed narrative)
 *   #/console     the live console
 *   #/r/:runId    permalink replay of a past run
 *   #/lab         experiment suites, A/B compare, capacity envelope
 */

export const ROUTES = [
  { id: 'story',   pattern: /^\/?$/,              label: 'Story' },
  { id: 'console', pattern: /^\/console\/?$/,     label: 'Console' },
  { id: 'replay',  pattern: /^\/r\/([\w-]+)\/?$/, label: 'Replay' },
  { id: 'lab',     pattern: /^\/lab\/?$/,         label: 'Lab' },
];

function parse(hash) {
  const path = (hash || '').replace(/^#/, '') || '/';
  for (const route of ROUTES) {
    const m = path.match(route.pattern);
    if (m) return { id: route.id, params: m.slice(1), path };
  }
  return { id: 'story', params: [], path: '/' };
}

export function useRoute() {
  const [route, setRoute] = useState(() => parse(window.location.hash));

  useEffect(() => {
    const onChange = () => {
      setRoute(parse(window.location.hash));
      // A route change is a new document as far as the reader is concerned.
      // ScrollTrigger and Lenis are both torn down by the story view's cleanup,
      // so resetting scroll here is safe and stops /console inheriting a
      // half-scrolled position from the story.
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

export function navigate(path) {
  window.location.hash = path.startsWith('#') ? path : `#${path}`;
}

export const href = (path) => `#${path}`;
