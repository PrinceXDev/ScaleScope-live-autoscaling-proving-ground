import { useEffect, useRef } from 'react';
import uPlot from 'uplot';

/**
 * A single-series trend of the oracle's own prediction error, oldest to
 * newest. One hue — `--predicted`, the same colour the forecast line uses
 * everywhere else in the product — because this is still the oracle's data,
 * just turned around to look at itself. No legend: a single series names
 * itself in the panel title, per the project's own accessibility convention
 * (see tokens.css and the dataviz guidance it follows).
 *
 * Built the same way as TimelineChart — direct uPlot canvas writes, no
 * virtual-DOM diff per point — rather than reused from it, because the data
 * shape here (index-ordered error samples, not a fixed time axis) doesn't fit
 * TimelineChart's parallel `t/containers/rps/p95` series contract.
 */
export default function AccuracyTrend({ pairs = [], height = 120 }) {
  const holderRef = useRef(null);
  const plotRef = useRef(null);

  // pairs arrive newest-first from /accuracy; chart reads oldest-to-newest.
  const ordered = [...pairs].reverse();
  const xs = ordered.map((_, i) => i);
  const errs = ordered.map((p) => p.absError);

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
        {
          label: 'abs error (containers)',
          stroke: 'var(--predicted)',
          width: 1.75,
          fill: 'var(--predicted)18',
          points: { show: false },
        },
      ],
      axes: [
        { show: false },
        { stroke: '#5c646f', grid: { stroke: '#23283130' }, ticks: { show: false }, size: 30 },
      ],
      scales: { x: { time: false } },
    };

    plotRef.current = new uPlot(opts, [xs, errs], holderRef.current);

    const onResize = () => plotRef.current?.setSize({ width: holderRef.current.clientWidth || 400, height });
    const ro = new ResizeObserver(onResize);
    ro.observe(holderRef.current);

    return () => { ro.disconnect(); plotRef.current?.destroy(); plotRef.current = null; };
    // The chart holder below is always rendered -- never swapped for an empty-
    // state placeholder -- specifically so this ref is non-null the one time
    // this effect runs. A conditional early return before this div would mean
    // the mount effect fires against a ref that is still null when there are
    // fewer than 2 pairs (true on a run's first tick), and since this effect
    // only runs once, the chart would never get a second chance to mount once
    // enough pairs arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    plotRef.current?.setData([xs, errs]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairs]);

  return (
    <div className="mini-timeline-wrap">
      <div className="chart accuracy-trend" ref={holderRef} />
      {pairs.length < 2 && <div className="mini-timeline-empty">not enough samples yet to plot a trend</div>}
    </div>
  );
}
