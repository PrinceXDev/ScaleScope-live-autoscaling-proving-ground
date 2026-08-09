import { Suspense, lazy, useEffect } from 'react';
import { useRoute } from './lib/router.js';
import { api } from './lib/api.js';
import { useStore } from './lib/store.js';
import Nav from './components/Nav.jsx';

/**
 * Route-level code splitting.
 *
 * The story page pulls in GSAP, ScrollTrigger, Flip and MotionPath; the console
 * pulls in uPlot. A judge who lands on the story and never opens the console
 * should not pay for uPlot, and someone who deep-links straight to a replay
 * should not download the scrollytelling machinery. On a phone over a
 * conference wifi that difference is the first three seconds of their
 * impression.
 */
const Story   = lazy(() => import('./views/Story.jsx'));
const Console = lazy(() => import('./views/Console.jsx'));
const Lab     = lazy(() => import('./views/Lab.jsx'));

export default function App() {
  const route = useRoute();
  const setTopology = useStore((s) => s.setTopology);
  const setBudget = useStore((s) => s.setBudget);

  // Topology and budget are small, cacheable and needed by more than one view,
  // so they're fetched once at the shell rather than per view.
  useEffect(() => {
    api.topology().then(setTopology).catch(() => {});
    api.budget().then(setBudget).catch(() => {});
    const id = setInterval(() => { api.budget().then(setBudget).catch(() => {}); }, 30_000);
    return () => clearInterval(id);
  }, [setTopology, setBudget]);

  return (
    <>
      <Nav route={route} />
      <Suspense fallback={<Booting />}>
        {route.id === 'story'   && <Story />}
        {route.id === 'console' && <Console />}
        {route.id === 'replay'  && <Console replayRunId={route.params[0]} />}
        {route.id === 'lab'     && <Lab />}
      </Suspense>
    </>
  );
}

function Booting() {
  return (
    <div className="booting">
      <div className="booting-bar"><i /></div>
      <p className="mono">initialising instrument…</p>
    </div>
  );
}
