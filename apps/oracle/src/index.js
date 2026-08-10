/**
 * The oracle.
 *
 * Zerops publishes the shape of its autoscaler -- vertical before horizontal,
 * configurable CPU thresholds -- and stops well short of the numbers you would
 * need to predict it: how much load one container actually absorbs at your
 * workload, how many seconds pass between demand crossing that line and a new
 * container serving traffic, how long a container lingers after demand falls.
 * Those three numbers are the difference between watching a platform and
 * modelling one, and none of them are in the docs. So the oracle learns them
 * from the runs it is already observing, and then it puts its neck out: every
 * second, for every live run, it publishes a forecast of the container count
 * fifteen seconds ahead, and the dashboard draws that forecast as a ghost line
 * running ahead of reality.
 *
 * On what this is, stated plainly.
 *
 * It is not machine learning. It is online parameter estimation on a
 * three-parameter lag model, fitted by exponentially-weighted least squares --
 * see `packages/control/src/twin.js`, which contains the entire estimator in
 * about a hundred lines. Calling it ML would be a better demo sentence and a
 * worse engineering claim, and the honest version is genuinely the stronger
 * one: a ninety-second run yields ninety data points, and ninety points do not
 * support a model with more than a handful of parameters. Choosing a small
 * model here is not a compromise forced by the deadline, it is the correct
 * response to the amount of data available. Anything larger would fit noise and
 * report confidence it had not earned.
 *
 * On why it earns its place.
 *
 * The forecast is not the product. The *error* is. A model that is right tells
 * you only that the autoscaler is behaving the way you already assumed. A model
 * that is wrong tells you precisely where and when the platform did something
 * your understanding of it does not contain -- a scale-up that arrived eleven
 * seconds late instead of the four the model expected, a container that was
 * held long after load collapsed, a step that never came at all. Each of those
 * divergences is timestamped, attached to a run, and reproducible. That is what
 * a finding looks like, and the oracle exists to manufacture them.
 *
 * This is also why the twin's parameters are persisted rather than held in
 * memory (see persistence.js). A model that resets on every container restart
 * can never be more surprised than a model that has never seen anything, and
 * being surprised is the entire job.
 *
 * Responsibilities, in order:
 *   1. one AutoscalerTwin per live run, seeded from persisted parameters
 *   2. observe every TickFrame, forecast ORACLE_HORIZON_S ahead
 *   3. broadcast the forecast for the live chart, append it to the event log
 *   4. on run completion, fold what was learned back into `twin_params`
 *   5. serve /params and /accuracy so the model's beliefs are inspectable
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { consumerOpts, createInbox } from 'nats';
import {
  connectBus, ensureStreams, subscribe, broadcast, appendEvent, jc,
} from '@scalescope/bus';
import {
  ORACLE, QUEUE_ORACLE, EVENT, evt, DEFAULT_RUN, CONTRACT_VERSION,
} from '@scalescope/contracts';
import { AutoscalerTwin } from '@scalescope/control';
import { log } from '@scalescope/telemetry';
import {
  twinKey, hostnameFromUrl, lookupRunConfig,
  loadTwinParams, saveTwinParams, listTwinParams, AccuracyLog,
} from './persistence.js';

process.env.SCALESCOPE_SERVICE = 'oracle';

const PORT = Number(process.env.PORT || 3000);

/**
 * How far ahead to forecast. Fifteen seconds is not arbitrary: it is chosen to
 * sit just past the scale-up lag the twin typically converges on, so the ghost
 * line is predicting the *arrival* of a container rather than merely restating
 * the current one. A horizon shorter than the lag makes the model look
 * flawless and say nothing.
 */
const HORIZON_S = Number(process.env.ORACLE_HORIZON_S || 15);

/**
 * A run with no frames for this long is over, whatever the event log says. This
 * is the backstop for the case the COMPLETED subscription cannot cover: a
 * gateway that died mid-run never emits a terminal event, and without a sweep
 * the twin for that run would sit in the map forever holding memory and
 * appearing on /params as though it were live.
 */
const IDLE_MS = Number(process.env.ORACLE_IDLE_MS || 30_000);

/**
 * Do not let a stub of a run overwrite a well-fitted model. A run that failed
 * after four seconds produced four observations, and folding those back into a
 * key with two hundred samples behind it would be actively destructive -- the
 * capacity estimate would be dragged toward whatever the target happened to be
 * doing during its first two ticks. Learning is cheap to skip and expensive to
 * corrupt.
 */
const MIN_FRAMES_TO_PERSIST = Number(process.env.ORACLE_MIN_FRAMES || 20);

/**
 * How wrong a forecast has to be, in containers, before it stops being noise
 * and becomes a finding worth putting on the timeline. Two containers is
 * deliberately not "any miss at all" -- a model built on ninety data points
 * will be off by a fraction of a container constantly, and flagging every
 * rounding difference would bury the divergences that actually mean
 * something (a scale-up that never came, a lag the twin hasn't learned yet)
 * under noise. This is the one number in the whole feature that trades
 * sensitivity for signal, so it is environment-configurable rather than
 * buried in the comparison itself.
 */
const FINDING_THRESHOLD_CONTAINERS = Number(process.env.ORACLE_FINDING_THRESHOLD || 2);

/** runId -> live twin state. One entry per run currently producing frames. */
const twins = new Map();

const accuracy = new AccuracyLog();

let nc = null;
let js = null;

// ---------------------------------------------------------------------------
// Twin lifecycle
// ---------------------------------------------------------------------------

/**
 * Look up (or create) the twin for a run.
 *
 * The seeding step is the point of the whole service. A new twin starts from
 * the priors baked into AutoscalerTwin -- 20 rps per container, 12s up, 45s
 * down -- which are educated guesses. Seeding it from `twin_params` instead
 * means the model starts each run wherever the last run left it, and the
 * confidence figure the dashboard shows is earned rather than assumed.
 */
async function ensureTwin(runId) {
  const existing = twins.get(runId);
  if (existing) return existing;

  // Placed in the map before the awaits below so that two frames arriving in
  // the same event-loop turn cannot each construct a twin and race to overwrite
  // each other. The NATS iterator delivers sequentially, but relying on that as
  // a correctness guarantee is the kind of assumption that quietly breaks when
  // someone adds a queue-group member.
  const entry = {
    runId,
    twin: null,
    ready: null,
    targetKey: null,
    rounds: DEFAULT_RUN.rounds,
    frames: 0,
    startedAt: Date.now(),
    lastFrameAt: Date.now(),
    /** Forecasts awaiting the tick they were made about. */
    pending: [],
    seeded: null,
  };
  twins.set(runId, entry);

  entry.ready = (async () => {
    const cfg = await lookupRunConfig(runId);
    entry.rounds = cfg?.rounds ?? DEFAULT_RUN.rounds;
    entry.targetKey = twinKey(hostnameFromUrl(cfg?.targetUrl ?? DEFAULT_RUN.targetUrl), entry.rounds);

    const persisted = await loadTwinParams(entry.targetKey);
    entry.seeded = persisted
      ? { samples: persisted.samples, meanAbsErr: persisted.meanAbsErr }
      : { samples: 0, meanAbsErr: null };
    entry.twin = new AutoscalerTwin(persisted?.params ?? {});

    log.info(
      `twin ready run=${runId} key=${entry.targetKey} `
      + `seeded=${persisted ? `${persisted.samples} prior runs` : 'cold (priors only)'}`,
    );
  })();

  await entry.ready;
  return entry;
}

/**
 * Match forecasts against the reality they were forecasting.
 *
 * The twin scores itself internally, but only in aggregate. Keeping the pairs
 * here as well is what lets /accuracy answer "*when* was it wrong", which is
 * the form of the question that produces findings. Pairing is done on the tick
 * axis rather than wall-clock because ticks are aligned across the fleet by
 * construction (see the bucket clock in @scalescope/telemetry) and wall-clock
 * is not.
 *
 * A miss past FINDING_THRESHOLD_CONTAINERS is promoted from a row in the
 * accuracy log to a durable EVENT.FINDING -- the same two-sink pattern
 * PREDICTION already uses, so a finding shows up on the live timeline within
 * the second it's detected, and shows up again at the same tick when the run
 * is replayed later.
 */
async function resolvePending(entry, frame) {
  if (!entry.pending.length) return;
  const kept = [];
  for (const p of entry.pending) {
    if (frame.t + 0.5 < p.dueT) { kept.push(p); continue; }
    // Anything more than two ticks stale is a gap in the frame stream, not a
    // forecast we can fairly score; drop it rather than scoring it against the
    // wrong second.
    if (frame.t - p.dueT <= 2) {
      const actual = frame.containers ?? 0;
      const absError = accuracy.record({
        runId: entry.runId,
        targetKey: entry.targetKey,
        t: frame.t,
        predictedAtT: p.t,
        horizonS: HORIZON_S,
        predicted: p.predicted,
        actual,
      });

      if (absError >= FINDING_THRESHOLD_CONTAINERS) {
        const finding = {
          // A real id, not a composite of other fields -- anything downstream
          // that wants to point back at "the finding that caused this" (the
          // auto-chaos loop does) needs a stable foreign key, not a string it
          // has to reconstruct from runId+t+targetKey and hope never collides.
          findingId: randomUUID(),
          runId: entry.runId,
          targetKey: entry.targetKey,
          t: frame.t,
          predictedAtT: p.t,
          horizonS: HORIZON_S,
          predicted: p.predicted,
          actual,
          absError,
        };
        broadcast(nc, 'finding', finding);
        await appendEvent(js, entry.runId, EVENT.FINDING, finding, 'oracle', frame.t);
      }
    }
  }
  entry.pending = kept;
}

async function onObserve(frame) {
  if (!frame || !frame.runId) return;

  const entry = await ensureTwin(frame.runId);
  entry.lastFrameAt = Date.now();
  entry.frames += 1;

  const result = entry.twin.observe(frame, HORIZON_S);

  await resolvePending(entry, frame);
  entry.pending.push({ t: frame.t, dueT: frame.t + HORIZON_S, predicted: result.predicted });

  const payload = {
    runId: frame.runId,
    t: frame.t,
    horizonS: HORIZON_S,
    predicted: result.predicted,
    confidence: result.confidence,
    meanAbsErrorContainers: accuracy.meanAbsError(frame.runId) ?? result.meanAbsErrorContainers,
    params: result.params,
  };

  // Two sinks, two different jobs. The broadcast is ephemeral and is what draws
  // the ghost line in the browser within the same second. The JetStream append
  // is durable and is what makes a replay of this run three hours from now show
  // the same forecast, made with the same information the model had at the
  // time -- not a re-forecast from a smarter model, which would be a lie about
  // what was predictable.
  broadcast(nc, 'prediction', payload);
  await appendEvent(js, frame.runId, EVENT.PREDICTION, payload, 'oracle', frame.t);
}

/**
 * Fold a finished run's learning back into the durable model.
 *
 * Note there is no broadcast here. The frontend subscribes to a fixed list of
 * SSE event names and "the oracle finished training" is not among them, so
 * emitting one would be dead weight on the bus. The dashboard sees this through
 * /params, which is where the question ("what does the model believe now?")
 * actually gets asked.
 */
async function finalise(runId, reason) {
  const entry = twins.get(runId);
  if (!entry) return;
  twins.delete(runId);

  try {
    await entry.ready;
  } catch {
    return;
  }
  if (!entry.twin) return;

  if (entry.frames < MIN_FRAMES_TO_PERSIST) {
    log.warn(
      `twin not persisted run=${runId} reason=${reason} frames=${entry.frames} `
      + `(below ${MIN_FRAMES_TO_PERSIST}; too little signal to be worth the risk of corrupting ${entry.targetKey})`,
    );
    return;
  }

  const mae = accuracy.meanAbsError(runId) ?? entry.twin.meanAbsError;
  const saved = await saveTwinParams(entry.targetKey, entry.twin.export(), mae);

  log.info(
    `twin persisted key=${entry.targetKey} reason=${reason} frames=${entry.frames} `
    + `mae=${mae == null ? 'n/a' : mae.toFixed(2)} samples=${saved?.samples ?? '?'} `
    + `capacity=${entry.twin.params.capacityPerContainer.toFixed(1)}rps/container `
    + `upLag=${entry.twin.params.scaleUpLagS.toFixed(1)}s downLag=${entry.twin.params.scaleDownLagS.toFixed(1)}s`,
  );
}

// ---------------------------------------------------------------------------
// Terminal-event watcher
// ---------------------------------------------------------------------------

/**
 * Watch the event log for runs ending.
 *
 * An ephemeral, ack-none, deliver-new consumer: the oracle only cares about
 * runs finishing while it is alive, and a durable consumer would replay every
 * completion since the stream was created on every restart, re-persisting
 * parameters for runs whose twins no longer exist. If JetStream refuses the
 * subscription for any reason we log it and carry on -- the idle sweep below
 * covers exactly the same ground, more slowly.
 */
async function watchTerminal(type) {
  const subject = evt('*', type);
  try {
    const opts = consumerOpts();
    opts.deliverNew();
    opts.ackNone();
    opts.deliverTo(createInbox());
    const sub = await js.subscribe(subject, opts);

    (async () => {
      for await (const m of sub) {
        try {
          const env = jc.decode(m.data);
          if (env?.runId && twins.has(env.runId)) await finalise(env.runId, type);
        } catch (err) {
          log.error(`terminal watcher failed on ${subject}: ${err.message}`);
        }
      }
    })().catch((err) => log.error(`terminal watcher ${subject} died: ${err.message}`));

    log.info(`watching ${subject} for run completion`);
  } catch (err) {
    log.warn(`could not watch ${subject} (${err.message}); falling back to the ${IDLE_MS}ms idle sweep`);
  }
}

function startIdleSweep() {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [runId, entry] of twins) {
      if (now - entry.lastFrameAt > IDLE_MS) {
        finalise(runId, 'idle').catch((err) => log.error(`idle finalise failed: ${err.message}`));
      }
    }
  }, 10_000);
  timer.unref?.();
  return timer;
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // The dashboard may reach this directly during local development, when it
    // is served by Vite on another origin. Read-only, no credentials, so the
    // wildcard costs nothing.
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** What the model believes right now, persisted and live, side by side. */
async function paramsView() {
  const live = [];
  for (const entry of twins.values()) {
    if (!entry.twin) continue;
    live.push({
      runId: entry.runId,
      targetKey: entry.targetKey,
      frames: entry.frames,
      seededFrom: entry.seeded,
      capacityPerContainer: Number(entry.twin.params.capacityPerContainer.toFixed(2)),
      scaleUpLagS: Number(entry.twin.params.scaleUpLagS.toFixed(2)),
      scaleDownLagS: Number(entry.twin.params.scaleDownLagS.toFixed(2)),
      maxContainers: entry.twin.params.maxContainers,
      minContainers: entry.twin.params.minContainers,
      confidence: entry.twin.confidence,
      meanAbsErrorContainers: accuracy.meanAbsError(entry.runId) ?? entry.twin.meanAbsError,
    });
  }
  return { horizonS: HORIZON_S, contractVersion: CONTRACT_VERSION, persisted: await listTwinParams(), live };
}

function startHttp() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://oracle.local');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      });
      res.end();
      return;
    }

    if (url.pathname === '/healthz') {
      json(res, 200, {
        ok: true,
        bus: nc ? !nc.isClosed() : false,
        liveTwins: twins.size,
        horizonS: HORIZON_S,
        accuracySamples: accuracy.entries.length,
      });
      return;
    }

    if (url.pathname === '/params') {
      paramsView()
        .then((body) => json(res, 200, body))
        .catch((err) => json(res, 500, { error: err.message }));
      return;
    }

    if (url.pathname === '/accuracy') {
      const runId = url.searchParams.get('runId');
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      json(res, 200, {
        horizonS: HORIZON_S,
        meanAbsErrorContainers: accuracy.meanAbsError(runId),
        exactRate: accuracy.exactRate(runId),
        pairs: accuracy.recent(limit, runId),
      });
      return;
    }

    json(res, 404, { error: 'not found' });
  });

  server.listen(PORT, () => log.info(`oracle http listening on ${PORT}`));
  return server;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  nc = await connectBus('oracle');
  js = nc.jetstream();
  await ensureStreams(nc);

  // QUEUE_ORACLE means one oracle container handles each tick even if several
  // are running. Two containers each maintaining their own half-fed twin for
  // the same run would both be wrong, and the ghost line would flicker between
  // two models -- so this queue group is load-shedding, not redundancy.
  subscribe(nc, ORACLE.OBSERVE, (frame) => onObserve(frame), { queue: QUEUE_ORACLE });

  await watchTerminal(EVENT.COMPLETED);
  await watchTerminal(EVENT.FAILED);
  startIdleSweep();

  const server = startHttp();
  log.info(`oracle up: horizon=${HORIZON_S}s idle=${IDLE_MS}ms`);

  const shutdown = async (signal) => {
    log.info(`oracle shutting down on ${signal}`);
    server.close();
    // Persist whatever the live twins have learned so far. A rolling deploy
    // mid-run would otherwise throw away a run's worth of fitting for no
    // reason other than the timing of the restart.
    await Promise.allSettled([...twins.keys()].map((id) => finalise(id, `shutdown:${signal}`)));
    await nc.drain().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
}

// A forecasting service that dies on one malformed frame is worse than useless:
// it takes the ghost line off the chart in the middle of the run it was built
// to explain. Log loudly, stay up.
process.on('unhandledRejection', (err) => log.error(`unhandled rejection: ${err?.message || err}`));
process.on('uncaughtException', (err) => log.error(`uncaught exception: ${err?.stack || err}`));

main().catch((err) => {
  log.error(`oracle failed to start: ${err.stack || err.message}`);
  process.exit(1);
});
