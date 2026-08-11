import { useEffect, useRef } from 'react';
import uPlot from 'uplot';

/**
 * A small, single- or dual-series timeline sharing the run's `t` axis.
 *
 * TimelineChart carries the three series load-bearing enough to earn a fixed
 * role in the main chart's legend. Everything else the collector already
 * computes every tick — error rate, the autopilot's concurrency output — sat
 * in the store unused rather than duplicating TimelineChart's fixed-role
 * contract for a second series that doesn't fit it. This is that second
 * chart: same uPlot-direct-write approach as TimelineChart and AccuracyTrend
 * (no virtual-DOM diff per point, since this also repaints every second for
 * the length of a run), sized to sit in a stat-row-sized panel rather than
 * the full-width hero position.
 */
export default function MiniTimeline({ t = [], series, height = 120 }) {
  const holderRef = useRef(null);
  const plotRef = useRef(null);

  function toData() {
    return [t, ...series.map((s) => s.data)];
  }

  useEffect(() => {
    if (!holderRef.current) return;

    const opts = {
      width: holderRef.current.clientWidth || 400,
      height,
      padding: [8, 8, 20, 34],
      cursor: { drag: { x: false, y: false } },
      legend: { show: false },
      series: [
        {},
        ...series.map((s) => ({
          label: s.label, stroke: s.color, width: 1.75,
          fill: s.fill ? `${s.color}18` : undefined,
          points: { show: false },
          scale: s.scale,
        })),
      ],
      axes: [
        { stroke: '#5c646f', grid: { stroke: '#23283130' }, ticks: { stroke: '#23283130' } },
        { stroke: series[0]?.color, grid: { show: false }, ticks: { show: false }, size: 30 },
        ...(series[1] ? [{ show: false, scale: series[1].scale }] : []),
      ],
      scales: { x: { time: false } },
    };

    plotRef.current = new uPlot(opts, toData(), holderRef.current);

    const onResize = () => plotRef.current?.setSize({ width: holderRef.current.clientWidth || 400, height });
    const ro = new ResizeObserver(onResize);
    ro.observe(holderRef.current);

    return () => { ro.disconnect(); plotRef.current?.destroy(); plotRef.current = null; };
    // The chart holder below is always rendered -- never swapped for an empty-
    // state placeholder -- specifically so this ref is non-null the one time
    // this effect runs. A conditional early return before this div would mean
    // the mount effect fires against a ref that is still null on a run's
    // first render (t.length starts at 0), and since this effect only runs
    // once, the chart would never get a second chance to actually mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    plotRef.current?.setData(toData());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, ...series.map((s) => s.data)]);

  return (
    <div className="mini-timeline-wrap">
      <div className="chart mini-timeline" ref={holderRef} />
      {t.length < 2 && <div className="mini-timeline-empty">not enough data yet to plot</div>}
    </div>
  );
}
