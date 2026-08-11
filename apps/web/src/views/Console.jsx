import { useEffect, useRef, useState } from 'react';
import { api, openStream } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { emitTopologyEvent } from '../motion/gsap.js';
import TimelineChart from '../components/TimelineChart.jsx';
import StatTile from '../components/StatTile.jsx';
import PredictionBet from '../components/PredictionBet.jsx';
import ReportCard from '../components/ReportCard.jsx';
import ContainerGrid from '../components/ContainerGrid.jsx';
import EventTicker from '../components/EventTicker.jsx';
import RunControls from '../components/RunControls.jsx';
import TopologyPanel from '../components/TopologyPanel.jsx';
import '../styles/console.css';
import '../styles/topology.css';

/**
 * The live console.
 *
 * This is the one view in the product where "live" and "replay" are, on
 * purpose, indistinguishable from the inside: both arrive as the same named
 * SSE events, both flow through `ingestTick`, and this component never checks
 * which one it's looking at. `replayRunId` only changes which query parameter
 * `openStream` is opened with.
 */
export default function Console({ replayRunId = null }) {
  const store = useStore();
  const [runs, setRuns] = useState([]);
  const closeRef = useRef(null);

  useEffect(() => {
    api.listRuns(30).then(setRuns).catch(() => {});
  }, [store.status]);

  useEffect(() => {
    store.setConnected(false);
    if (replayRunId) store.resetRun(replayRunId, null, 'replay');

    closeRef.current?.();
    closeRef.current = openStream(handleEvent, replayRunId ? { runId: replayRunId, replay: true } : {});
    store.setConnected(true);

    return () => closeRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayRunId]);

  function handleEvent(event, data) {
    emitTopologyEvent(event, data);
    const s = useStore.getState();
    switch (event) {
      case 'run.created':
        s.resetRun(data.runId, data, replayRunId ? 'replay' : 'live');
        break;
      case 'run.started':
        s.resetRun(data.runId, data.config ?? s.runConfig, replayRunId ? 'replay' : 'live');
        break;
      case 'tick':
        s.ingestTick(data);
        break;
      case 'prediction':
        s.pushPrediction(data);
        break;
      case 'scaled':
        s.pushScale(data);
        break;
      case 'slo':
        s.pushSlo(data);
        break;
      case 'chaos':
        s.pushChaos(data);
        break;
      case 'finding':
        s.pushFinding(data);
        break;
      case 'worker.hello':
        s.seeWorker(data.workerId);
        break;
      case 'run.completed':
      case 'run.failed':
        s.completeRun(data);
        api.listRuns(30).then(setRuns).catch(() => {});
        break;
      default:
        break;
    }
  }

  const start = async (config) => {
    const res = await api.startRun(config);
    store.resetRun(res.runId, config, 'live');
    return res;
  };
  const stop = () => store.runId && api.stopRun(store.runId).catch(() => {});
  const setpoint = (ms) => store.runId && api.setpoint(store.runId, ms).catch(() => {});

  const instances = [...store.instances.values()].sort((a, b) => b.requests - a.requests);
  const running = store.status === 'running';

  return (
    <div className="page console">
      <div className="console-grid">
        <section className="panel console-chart-panel">
          <header className="panel-head">
            <span className="panel-title">Timeline</span>
            <span className="panel-note mono">
              {store.source === 'replay' ? `replaying ${replayRunId?.slice(0, 8)}` : store.runId ? `run ${store.runId.slice(0, 8)}` : 'idle'}
            </span>
          </header>
          <div className="panel-body">
            <TimelineChart
              t={store.series.t}
              containers={store.series.containers}
              rps={store.series.rps}
              p95={store.series.p95}
              predicted={store.series.predicted}
              scaleEvents={store.scaleEvents}
              chaosEvents={store.chaosEvents}
              sloEvents={store.sloEvents}
              findingEvents={store.findingEvents}
            />
            <div className="chart-legend">
              <span><i style={{ background: 'var(--containers)' }} />containers</span>
              <span><i style={{ background: 'var(--throughput)' }} />req/s</span>
              <span><i style={{ background: 'var(--latency)' }} />p95 ms</span>
              <span><i style={{ background: 'var(--predicted)', borderStyle: 'dashed' }} />predicted</span>
              <span><i style={{ background: 'var(--finding)' }} />finding</span>
            </div>
          </div>
        </section>

        <div className="stat-row">
          <StatTile label="containers" value={store.frame?.containers ?? 0} color="var(--containers)" note={`peak ${store.peak.containers}`} />
          <StatTile label="req/s" value={store.frame?.rps ?? 0} color="var(--throughput)" note={`peak ${Math.round(store.peak.rps)}`} />
          <StatTile label="p95" value={store.frame?.p95 ?? 0} unit="ms" color="var(--latency)" note={`peak ${Math.round(store.peak.p95)}`} />
          <StatTile label="cost" value={store.costUsd} unit="usd" decimals={4} color="var(--cost)" note="estimated" />
          <StatTile label="time to recover" value={store.timeToRecoverS ?? '—'} unit={store.timeToRecoverS ? 's' : ''} color="var(--good)" />
        </div>

        {store.status === 'completed' && <ReportCard scorecard={store.scorecard} />}

        <PredictionBet
          pendingBet={store.pendingBet}
          betHistory={store.betHistory}
          betAccuracy={store.betAccuracy}
        />

        <section className="panel">
          <header className="panel-head"><span className="panel-title">Containers, observed</span></header>
          <div className="panel-body">
            <ContainerGrid instances={instances} />
          </div>
        </section>

        <section className="panel">
          <header className="panel-head"><span className="panel-title">Run</span></header>
          <div className="panel-body">
            {!replayRunId && (
              <RunControls onStart={start} onStop={stop} onSetpoint={setpoint} running={running} budget={store.budget} />
            )}
            {replayRunId && <p className="field-hint">Replaying a past run — start a new one from the Console (drop the permalink) to control it live.</p>}
          </div>
        </section>

        <section className="panel">
          <header className="panel-head"><span className="panel-title">Annotations</span></header>
          <div className="panel-body">
            <EventTicker
              scaleEvents={store.scaleEvents}
              sloEvents={store.sloEvents}
              chaosEvents={store.chaosEvents}
              findingEvents={store.findingEvents}
            />
          </div>
        </section>

        <TopologyPanel />

        <section className="panel console-history">
          <header className="panel-head"><span className="panel-title">Run history</span></header>
          <div className="panel-body">
            <ul className="run-history">
              {runs.map((r) => (
                <li key={r.id}>
                  <a href={`#/r/${r.id}`}>{r.name}</a>
                  <span className="mono">
                    {r.peak_containers ?? '—'} ctr · p95 {r.peak_p95_ms ? Math.round(r.peak_p95_ms) : '—'}ms · {r.status}
                    {r.scorecard?.grade && <span className="run-history-grade"> · grade {r.scorecard.grade}</span>}
                  </span>
                </li>
              ))}
              {runs.length === 0 && <li className="mono">no runs yet</li>}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
