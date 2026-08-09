import { useEffect, useRef } from 'react';
import uPlot from 'uplot';

/**
 * The chart everything else in this product points at.
 *
 * uPlot rather than Chart.js or Recharts: it renders a few hundred points at
 * sixty frames a second on a canvas with no virtual-DOM diffing in the way,
 * which matters here specifically because this chart repaints every second for
 * the entire length of a run, live, while the rest of the page is also
 * animating. A React-friendly charting library re-evaluates its own component
 * tree on every data change; uPlot's `setData` call touches the canvas
 * directly and nothing else, so the chart staying smooth does not compete with
 * GSAP for the same frame budget.
 *
 * Three series are drawn at fixed roles -- containers (the brand colour, always
 * present), throughput, and latency -- plus an optional dashed prediction line.
 * Vertical bands mark chaos and SLO-breach windows so an annotation reads as
 * part of the chart rather than a separate list underneath it.
 */
export default function TimelineChart({
  t = [], containers = [], rps = [], p95 = [], predicted = [],
  scaleEvents = [], chaosEvents = [], sloEvents = [], height = 260,
}) {
  const holderRef = useRef(null);
  const plotRef = useRef(null);

  useEffect(() => {
    if (!holderRef.current) return;

    const opts = {
      width: holderRef.current.clientWidth || 600,
      height,
      padding: [12, 12, 24, 42],
      cursor: { drag: { x: true, y: false } },
      legend: { show: false },
      series: [
        {},
        { label: 'containers', stroke: 'var(--containers)', width: 2, points: { show: false } },
        { label: 'req/s', stroke: 'var(--throughput)', width: 1.5, points: { show: false }, scale: 'rps' },
        { label: 'p95 ms', stroke: 'var(--latency)', width: 1.5, points: { show: false }, scale: 'ms' },
        {
          label: 'predicted', stroke: 'var(--predicted)', width: 1.5, points: { show: false },
          dash: [4, 4],
        },
      ],
      axes: [
        { stroke: '#5c646f', grid: { stroke: '#23283130' }, ticks: { stroke: '#23283130' } },
        {
          stroke: 'var(--containers)', grid: { show: false }, ticks: { show: false },
          size: 34,
        },
        { show: false, scale: 'rps' },
        { show: false, scale: 'ms' },
      ],
      scales: { x: { time: false } },
      hooks: {
        drawSeries: [
          (u) => drawBands(u, [
            ...chaosEvents.map((e) => ({ t: e.at ? e.t ?? e.at : e.t, color: 'var(--breach-dim)', width: 2 })),
          ]),
        ],
      },
    };

    plotRef.current = new uPlot(opts, toData(), holderRef.current);

    const onResize = () => plotRef.current?.setSize({ width: holderRef.current.clientWidth || 600, height });
    const ro = new ResizeObserver(onResize);
    ro.observe(holderRef.current);

    return () => { ro.disconnect(); plotRef.current?.destroy(); plotRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toData() {
    return [t, containers, rps, p95, predicted.map((v) => (v == null ? null : v))];
  }

  useEffect(() => {
    plotRef.current?.setData(toData());
  }, [t, containers, rps, p95, predicted]);

  return <div className="chart" ref={holderRef} />;
}

function drawBands(u, marks) {
  const { ctx } = u;
  ctx.save();
  for (const m of marks) {
    if (m.t == null) continue;
    const x = u.valToPos(m.t, 'x', true);
    ctx.strokeStyle = '#FF5E5E88';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x, u.bbox.top);
    ctx.lineTo(x, u.bbox.top + u.bbox.height);
    ctx.stroke();
  }
  ctx.restore();
}
