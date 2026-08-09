/**
 * The target: the service under test, and the only honest instrument in the
 * system.
 *
 * Everything ScaleScope claims about Zerops autoscaling is ultimately derived
 * from four response headers this file sets. There is no platform API call
 * anywhere in the measurement path, and that is the point: a container count
 * reported by the thing being measured is a claim, whereas a container count
 * reconstructed from observed responses is evidence. If Zerops adds a container
 * and it never serves a request, ScaleScope will say so, because the container
 * only enters the count by answering.
 *
 * Dependency note, and a deliberate one: this service depends on express and
 * nothing else -- not even the workspace's own telemetry package, which every
 * other service uses for logging. The target is the measuring stick. Sharing
 * code with the things doing the measuring invites a change over in
 * @scalescope/telemetry to quietly alter what the ruler says, and a hackathon
 * is exactly the environment where that kind of coupling bites at 2am. The cost
 * is the eight-line logger below; the benefit is that the target can be lifted
 * out of this repo and run standalone against any load generator at all.
 */

import crypto from 'node:crypto';
import express from 'express';

// ---------------------------------------------------------------------------
// Container identity
// ---------------------------------------------------------------------------

/**
 * Generated once, at module load, which on Zerops means once per container.
 * This is the entire basis of container identity in ScaleScope: we never ask
 * the platform how many containers exist, we count distinct values of this
 * string as they appear in response headers. Eight characters of a v4 UUID is
 * 32 bits of entropy, which is absurd overkill for a fleet that peaks in the
 * low tens and short enough to render in a chart legend.
 */
const INSTANCE_ID = crypto.randomUUID().slice(0, 8);

/** Wall-clock birth of this container, used to compute X-Instance-Age. */
const BOOT_MS = Date.now();

const PORT = Number(process.env.PORT) || 3000;

/**
 * Shared secret for the admin surface. Read once at boot rather than per
 * request so that the "unset means deny everything" decision is made in one
 * place and cannot drift.
 */
const CHAOS_SECRET = process.env.CHAOS_SECRET || '';

/** Header the chaos injector presents. Must match apps/chaos/src/index.js. */
const SECRET_HEADER = 'x-chaos-secret';

/** Matches the clamp in @scalescope/contracts LIMITS.rounds. */
const ROUNDS_MIN = 1000;
const ROUNDS_MAX = 60_000;

const log = (level, ...args) => {
  const line = `[${new Date().toISOString()}] [target:${INSTANCE_ID}] ${level}`;
  (level === 'ERROR' ? console.error : console.log)(line, ...args);
};

// ---------------------------------------------------------------------------
// Mutable per-container state
// ---------------------------------------------------------------------------

/**
 * Monotonic count of requests this container has answered since boot. It is
 * never reset and never shared -- two containers each report their own -- which
 * is what makes it useful: the dashboard can show request share per container
 * and, more importantly, spot the pathological case where a container was added
 * and then received no traffic at all. A container count alone cannot see that;
 * "three containers exist" and "three containers are working" are different
 * facts and only one of them is worth paying for.
 */
let served = 0;

/**
 * Injected degradation, process-wide and time-boxed. Chaos sets it, and it
 * expires on its own rather than needing a matching "undo" command, because a
 * chaos injector that crashes between degrade and restore leaves the experiment
 * permanently poisoned and the next twenty runs silently wrong. A TTL fails
 * safe; a paired command does not.
 */
const degradation = { jitterMs: 0, failRate: 0, untilMs: 0 };

const activeDegradation = () => (
  Date.now() < degradation.untilMs
    ? degradation
    : { jitterMs: 0, failRate: 0, untilMs: 0 }
);

let shuttingDown = false;

// ---------------------------------------------------------------------------
// Admin authorisation
// ---------------------------------------------------------------------------

/**
 * Constant-time comparison of the presented secret against the configured one.
 *
 * A plain `presented === CHAOS_SECRET` short-circuits at the first differing
 * byte, so the time it takes to reject is a function of how many leading bytes
 * you got right. Against an endpoint that will happily kill a container, that
 * leak is enough to recover the secret one byte at a time over enough requests
 * -- and this endpoint is reachable from anywhere on the project's internal
 * network, which during a public hackathon demo is not a comfortable place to
 * be relying on nobody bothering.
 *
 * timingSafeEqual requires equal-length buffers and throws otherwise, which
 * would itself leak the secret's length. Hashing both sides first gives two
 * 32-byte digests unconditionally, so length is no longer observable either.
 *
 * If CHAOS_SECRET is unset we deny everything rather than defaulting to open.
 * An unconfigured kill switch that works is worse than one that doesn't.
 */
function authorised(req) {
  if (!CHAOS_SECRET) return false;
  const presented = String(req.get(SECRET_HEADER) || '');
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(CHAOS_SECRET).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '16kb' }));

// Express keeps a `Connection: keep-alive` conversation going by default, which
// is what we want: the worker holds an explicit keep-alive agent and we would
// rather measure the target's latency than TCP handshakes.
app.disable('x-powered-by');
app.set('etag', false);

/**
 * The measurement substrate.
 *
 * Every response leaves here carrying the four headers below, including
 * healthchecks and errors. Setting them in one place rather than per route is
 * deliberate: a route that forgets them is invisible to the dashboard, and the
 * failure looks like "the container vanished for a second" rather than like a
 * bug.
 */
app.use((req, res, next) => {
  served += 1;
  const servedNow = served;

  res.set({
    /**
     * X-Instance-Id: which container answered.
     *
     * Distinct values observed within a rolling window ARE the container count.
     * Downstream this becomes uniqExact(target_instance) in ClickHouse and a
     * sorted set in Valkey; both are just "how many different containers said
     * hello this second".
     */
    'X-Instance-Id': INSTANCE_ID,

    /**
     * X-Instance-Age: milliseconds since this container booted.
     *
     * This is the header that turns a container *count* into a container
     * *lifecycle swimlane*, and it solves a genuinely subtle measurement
     * problem. Consider the moment the count goes from 2 to 3. There are two
     * completely different worlds that produce that observation:
     *
     *   (a) Zerops actually started a new container in response to load. That
     *       is the finding -- it is the entire thesis of the project.
     *   (b) A third container existed the whole time, and this is simply the
     *       first second in which the load balancer happened to route one of
     *       our requests to it. Nothing scaled. Nothing happened.
     *
     * From ids alone the two are indistinguishable, and a chart that cannot
     * tell them apart will happily report phantom scale-ups whenever traffic
     * shifts. The age disambiguates them completely: in world (a) the newcomer
     * announces itself with an age of a few hundred milliseconds, in world (b)
     * it arrives already tens of seconds old. The dashboard uses exactly this
     * to draw a swimlane bar whose left edge is the container's real birth,
     * back-dated from `wallMs - ageMs`, rather than the moment we noticed it.
     *
     * The alternative -- asking the Zerops API which containers exist -- would
     * be easier and strictly worse, because it would be the platform grading
     * its own homework.
     */
    'X-Instance-Age': String(Date.now() - BOOT_MS),

    /** See the `served` declaration above for why per-container share matters. */
    'X-Instance-Served': String(servedNow),

    /**
     * X-Work-Ms: CPU time actually spent inside pbkdf2 for this request.
     * Overwritten with the real figure by /work; zero everywhere else.
     *
     * This is the single most diagnostic number the target produces, because it
     * splits a latency measurement into its two causes, which look identical
     * from the client and mean opposite things:
     *
     *   - The container is SATURATED. Work-ms is large. The CPU is genuinely
     *     oversubscribed, each request is being time-sliced against its
     *     neighbours, and the fix is more CPU -- i.e. another container.
     *   - The request QUEUED. Work-ms is small and flat, but wall latency is
     *     large. The container is fine; the request simply sat in the accept
     *     queue or behind the event loop waiting its turn.
     *
     * Same wall latency, same p95, entirely different story. Only the target
     * can tell you which, because only the target is on the inside of the
     * queue. Comparing the worker's wall latency against this figure is how the
     * dashboard can say "latency rose but the containers weren't working
     * harder" -- which is what a saturated ingress or an under-provisioned
     * connection pool looks like, and is a completely different remedy from
     * scaling out.
     */
    'X-Work-Ms': '0',
  });

  // During graceful shutdown we still answer -- with the headers attached, so
  // the worker observes the container right up to the moment it leaves. Going
  // silent instead would make a clean drain look like a crash on the chart.
  if (shuttingDown) {
    res.set('Connection', 'close');
    return res.status(503).json({ ok: false, draining: true, instance: INSTANCE_ID });
  }

  return next();
});

const clampRounds = (raw, fallback) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(ROUNDS_MAX, Math.max(ROUNDS_MIN, Math.floor(n)));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET /work?rounds=N&jitter=M&fail=P
 *
 * pbkdf2Sync is chosen over a busy loop for one reason: it is honest CPU work
 * that the JIT cannot elide and that scales linearly and predictably with
 * `rounds`, so "double the rounds" reliably means "double the CPU". A hand
 * rolled spin loop tends to get optimised into something that measures the
 * optimiser. It is also synchronous on purpose -- it blocks this container's
 * event loop exactly the way a real CPU-bound handler does, which is the
 * behaviour we need the autoscaler to react to. Offloading to the threadpool
 * would make the container look infinitely scalable and there would be nothing
 * to demonstrate.
 */
app.get('/work', async (req, res) => {
  const rounds = clampRounds(req.query.rounds, 12_000);
  const active = activeDegradation();

  // Query params and injected degradation compose rather than override: chaos
  // sets a floor for the whole container, an individual request can ask for
  // more, and neither can cancel the other out. Letting a request opt out of an
  // injected fault would let the load generator accidentally hide the very
  // thing the experiment injected.
  const jitterMs = Math.max(0, Number(req.query.jitter) || 0, active.jitterMs);
  const failRate = Math.min(1, Math.max(0, Number(req.query.fail) || 0, active.failRate));

  // The jitter goes BEFORE the work, not after, so it behaves like a slow
  // upstream dependency the handler is waiting on rather than like slow local
  // compute. That distinction shows up in X-Work-Ms -- an injected partition
  // produces high wall latency with unchanged work time, which is exactly the
  // signature the dashboard should be teaching people to recognise.
  if (jitterMs > 0) await sleep(jitterMs);

  if (failRate > 0 && Math.random() < failRate) {
    return res.status(503).json({ ok: false, instance: INSTANCE_ID, injected: true });
  }

  // hrtime.bigint is monotonic and nanosecond-resolution; Date.now() is neither,
  // and an NTP correction mid-run would otherwise show up as a latency spike
  // that no amount of scaling explains.
  const startNs = process.hrtime.bigint();
  const digest = crypto.pbkdf2Sync('scalescope', 'salt', rounds, 32, 'sha256');
  const workMs = Number(process.hrtime.bigint() - startNs) / 1e6;

  res.set('X-Work-Ms', workMs.toFixed(3));
  return res.json({
    ok: true,
    instance: INSTANCE_ID,
    rounds,
    workMs: Number(workMs.toFixed(3)),
    // Returned only so the derivation cannot be dead-code-eliminated by a future
    // refactor that decides the digest is unused. Four bytes on the wire.
    proof: digest.toString('hex').slice(0, 8),
  });
});

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    instance: INSTANCE_ID,
    uptimeMs: Date.now() - BOOT_MS,
    served,
  });
});

/**
 * POST /admin/degrade  { jitterMs, failRate, ttlS }
 *
 * Process-wide, TTL-bounded fault injection. See `degradation` above for why it
 * expires by itself.
 */
app.post('/admin/degrade', (req, res) => {
  if (!authorised(req)) return res.status(403).json({ ok: false, error: 'forbidden' });

  const jitterMs = Math.min(30_000, Math.max(0, Number(req.body?.jitterMs) || 0));
  const failRate = Math.min(1, Math.max(0, Number(req.body?.failRate) || 0));
  const ttlS = Math.min(300, Math.max(1, Number(req.body?.ttlS) || 15));

  degradation.jitterMs = jitterMs;
  degradation.failRate = failRate;
  degradation.untilMs = Date.now() + ttlS * 1000;

  log('INFO', `degrade jitter=${jitterMs}ms fail=${failRate} ttl=${ttlS}s`);
  return res.json({ ok: true, instance: INSTANCE_ID, jitterMs, failRate, ttlS });
});

/**
 * POST /admin/quit -- the container kills itself.
 *
 * This is deliberately cruder than asking the Zerops API to terminate a
 * container, and the tradeoff is right for this project in three separate ways.
 *
 * There is no token. A platform API call needs a credential that has to be
 * issued, stored in the environment of a service whose whole job is to break
 * things, and rotated if the repo ever goes public. Killing a container from
 * the inside needs a shared secret that only ever grants the ability to stop a
 * process we already control -- the blast radius of leaking it is "someone
 * restarts our demo app", not "someone has our platform credentials".
 *
 * There is no permission to configure. A judge, or anyone cloning this repo,
 * can run the entire chaos story locally with docker compose and get identical
 * behaviour, because process.exit(0) means the same thing everywhere. An API
 * based killer is a feature that only works in one account, which in practice
 * means it is a feature nobody but the author ever sees working.
 *
 * And it is more faithful to what we claim to be testing. Zerops' healthcheck
 * and restart machinery is a real part of the system under test; an in-band
 * exit exercises it, whereas an out-of-band API termination bypasses it. We
 * want to observe the platform noticing and reacting, not to instruct the
 * platform and then observe our own instruction.
 *
 * Exit code 0 rather than a crash code, because we are simulating an instance
 * going away, not asking the orchestrator to treat this as a failing image.
 */
app.post('/admin/quit', (req, res) => {
  if (!authorised(req)) return res.status(403).json({ ok: false, error: 'forbidden' });

  log('WARN', `quit requested; served=${served} age=${Date.now() - BOOT_MS}ms`);
  res.json({ ok: true, instance: INSTANCE_ID, served, ageMs: Date.now() - BOOT_MS });

  // Respond first, die second. The 100ms gives the response time to flush --
  // if we exited synchronously the chaos service would see a socket hang up and
  // could not distinguish "the kill worked" from "the kill never arrived", and
  // the run annotation would be a guess.
  setTimeout(() => process.exit(0), 100);
});

const server = app.listen(PORT, () => {
  log('INFO', `listening on :${PORT} boot=${new Date(BOOT_MS).toISOString()}`);
});

// Keep-alive tuning: the worker holds sockets open across an entire run, so the
// server must not be the party that closes them. Node's 5s default would churn
// connections mid-run and add reconnect cost to our latency measurements.
server.keepAliveTimeout = 72_000;
server.headersTimeout = 75_000;

/**
 * Graceful shutdown.
 *
 * On scale-down Zerops sends SIGTERM and then waits. Exiting immediately would
 * abort in-flight requests, and those aborts land in the worker's error counter
 * -- so a *successful* scale-down would show up on the dashboard as an error
 * spike, which is precisely backwards. Draining costs a second and removes a
 * whole class of misleading artefact from the chart.
 */
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('INFO', `${signal} received, draining (served=${served})`);

  server.close(() => {
    log('INFO', 'drained cleanly');
    process.exit(0);
  });

  // A request blocked on a large pbkdf2 or an injected 20s jitter must not hold
  // the container open past the platform's own patience, or SIGTERM becomes
  // SIGKILL and we lose the clean drain we just paid for.
  setTimeout(() => {
    log('WARN', 'drain timed out, exiting anyway');
    process.exit(0);
  }, 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A load target that dies on one bad request takes the experiment with it, and
// the resulting chart looks like a platform failure rather than our bug.
process.on('unhandledRejection', (err) => log('ERROR', 'unhandled rejection', err));
process.on('uncaughtException', (err) => log('ERROR', 'uncaught exception', err));
