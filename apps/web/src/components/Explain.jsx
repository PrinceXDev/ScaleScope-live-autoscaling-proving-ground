/**
 * The "?" affordance used anywhere a label alone isn't enough to know what a
 * number means or how it's computed — stat tiles, the chart legend, wherever
 * else jargon shows up unexplained. A real <button> rather than a span with a
 * hover handler, so it's keyboard-focusable and screen-reader-navigable on
 * its own: a judge tabbing through the page gets the same explanation a mouse
 * user gets by hovering. See .stat-explain in console.css for the reveal
 * mechanics (CSS-only, no JS state, works before React hydrates).
 */
export default function Explain({ label, children }) {
  return (
    <button type="button" className="stat-explain" aria-label={`How ${label} is calculated`}>
      <span aria-hidden="true">?</span>
      <span className="stat-explain-card" role="tooltip">{children}</span>
    </button>
  );
}
