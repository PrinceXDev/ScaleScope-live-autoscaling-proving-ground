/**
 * The Autoscaler Report Card.
 *
 * A capability report, not a verdict -- which is why every row carries its
 * method in plain language right next to its number. A grade with a hidden
 * method reads as an accusation; a grade with a visible one reads as a
 * measurement, and measurement is the only claim this panel is entitled to
 * make about a platform it does not own.
 *
 * Pure display: every number here already lived in `run.scorecard`, computed
 * once at finalisation by `packages/control/src/scorecard.js`. This
 * component does no math of its own beyond formatting.
 */

const METRIC_ROWS = [
  { key: 'reactionTimeS', label: 'Reaction time', unit: 's' },
  { key: 'settlingTimeS', label: 'Settling time', unit: 's' },
  { key: 'overshootRatio', label: 'Overshoot', unit: '×' },
  { key: 'flapPerMinute', label: 'Flap score', unit: '/min' },
  { key: 'costEfficiencyRatio', label: 'Cost efficiency', unit: '×' },
  { key: 'recoveryTimeS', label: 'Recovery', unit: 's' },
];

function gradeTone(grade) {
  if (!grade) return 'grade-unknown';
  if (grade.startsWith('A')) return 'grade-a';
  if (grade.startsWith('B')) return 'grade-b';
  if (grade.startsWith('C')) return 'grade-c';
  return 'grade-low';
}

export default function ReportCard({ scorecard }) {
  if (!scorecard) {
    return (
      <section className="panel report-card">
        <header className="panel-head"><span className="panel-title">Autoscaler report card</span></header>
        <div className="panel-body">
          <p className="field-hint">graded once this run completes</p>
        </div>
      </section>
    );
  }

  const { metrics, methodology, composite, grade } = scorecard;

  return (
    <section className="panel report-card">
      <header className="panel-head">
        <span className="panel-title">Autoscaler report card</span>
        <span className="panel-note mono">capability report, not a verdict</span>
      </header>
      <div className="panel-body report-card-body">
        <div className={`report-grade ${gradeTone(grade)}`}>
          <span className="report-grade-letter">{grade ?? '—'}</span>
          <span className="report-grade-composite mono">{composite != null ? `${composite}/100` : 'insufficient data'}</span>
        </div>

        <ul className="report-metrics">
          {METRIC_ROWS.map(({ key, label, unit }) => {
            const value = metrics?.[key];
            return (
              <li key={key} className="report-metric">
                <div className="report-metric-head">
                  <span className="report-metric-label">{label}</span>
                  <span className="report-metric-value mono">
                    {value == null ? '—' : `${value}${unit}`}
                  </span>
                </div>
                <div className="report-metric-method">{methodology?.[key]}</div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
