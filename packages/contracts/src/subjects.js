/**
 * ScaleScope subject map.
 *
 * Every subject in the system is declared here, exactly once, with its
 * delivery semantics written down next to it. Nothing in this repo is
 * allowed to type a subject string inline -- if it isn't in this file it
 * doesn't exist.
 *
 * Three delivery semantics are in play, each chosen deliberately:
 *
 *   PLAIN     Core NATS, no queue group. Every subscriber receives every
 *             message. Used for commands that must reach the whole fleet
 *             (a run has to start on all workers, not one of them) and for
 *             UI fan-out (every gateway container must push to its own SSE
 *             clients).
 *
 *   QUEUE     Core NATS with a queue group. Exactly one member of the group
 *             receives each message. Used for ingest, so the collector can
 *             scale horizontally without double-counting.
 *
 *   STREAM    JetStream. Persisted, replayable, ordered. Used for the run
 *             event log, which is the system of record that Postgres,
 *             ClickHouse and Valkey are all projections of.
 *
 * Fire-and-forget Core NATS is correct for telemetry: a dropped sample is a
 * missing pixel, not a lost order. Durability is reserved for the event log,
 * where losing an event would mean losing the run itself.
 */

/** @typedef {'PLAIN'|'QUEUE'|'STREAM'} Semantics */

// ---------------------------------------------------------------------------
// Control plane -- gateway to fleet. PLAIN: every worker must hear this.
// ---------------------------------------------------------------------------

export const CTRL = {
  /** Gateway -> workers. "Arm yourselves for this run, don't fire yet." */
  PREPARE: 'ctrl.run.prepare',
  /** Workers -> gateway. Arm acknowledgement, carries worker identity. */
  READY: 'ctrl.run.ready',
  /** Gateway -> workers. Carries an absolute epoch T0; everyone starts then. */
  GO: 'ctrl.run.go',
  /** Gateway -> workers. Halt immediately. */
  STOP: 'ctrl.run.stop',
  /** Gateway -> workers. Live setpoint change mid-run (autopilot target). */
  SETPOINT: 'ctrl.run.setpoint',
};

// ---------------------------------------------------------------------------
// Telemetry -- fleet to collector. QUEUE: exactly-once handling per sample.
// ---------------------------------------------------------------------------

export const TELEMETRY = {
  /** Worker -> collector. One row per (worker, target instance) per second. */
  SAMPLE: 'telemetry.sample',
  /** Worker -> anyone. Heartbeat. PLAIN so gateway and collector both see it. */
  HELLO: 'telemetry.worker.hello',
  /** Collector -> gateway. Ingest lag / watermark, for the backpressure gauge. */
  WATERMARK: 'telemetry.watermark',
};

/** Queue group name for telemetry ingest. Collector containers share this. */
export const QUEUE_COLLECTOR = 'collector';

/** Queue group name for chaos command handling. */
export const QUEUE_CHAOS = 'chaos';

/** Queue group name for oracle prediction work. */
export const QUEUE_ORACLE = 'oracle';

// ---------------------------------------------------------------------------
// Event log -- JetStream. The system of record.
// ---------------------------------------------------------------------------

/** JetStream stream name holding every run event, ever. */
export const STREAM_RUNS = 'SCALESCOPE_RUNS';

/** Subject wildcard the stream captures. */
export const STREAM_RUNS_SUBJECTS = 'evt.run.*.*';

/**
 * Build the event subject for a run.
 * @param {string} runId
 * @param {string} type one of EVENT_TYPES
 */
export const evt = (runId, type) => `evt.run.${runId}.${type}`;

/** Every event on a single run, in order. Used by the replay engine. */
export const evtAll = (runId) => `evt.run.${runId}.*`;

// ---------------------------------------------------------------------------
// UI fan-out -- PLAIN, so every gateway container serves its own SSE clients
// regardless of which container ingested the underlying sample. This is what
// makes the gateway horizontally scalable without splitting the dashboard.
// ---------------------------------------------------------------------------

export const UI = {
  /** Anything -> all gateway containers -> all connected browsers. */
  BROADCAST: 'ui.broadcast',
};

// ---------------------------------------------------------------------------
// Chaos + scheduler
// ---------------------------------------------------------------------------

export const CHAOS = {
  /** Gateway/scheduler -> chaos. QUEUE: one injector acts. */
  COMMAND: 'chaos.command',
};

export const SUITE = {
  /** Gateway -> scheduler. Kick off an experiment suite. */
  START: 'suite.start',
  /** Gateway -> scheduler. Abort the running suite. */
  ABORT: 'suite.abort',
  /** Scheduler -> anyone. Suite lifecycle updates. */
  PROGRESS: 'suite.progress',
};

export const ORACLE = {
  /** Collector -> oracle. A tick landed; predict forward. QUEUE. */
  OBSERVE: 'oracle.observe',
  /** Gateway -> oracle. Run the capacity-envelope solver. */
  SOLVE: 'oracle.solve',
};

/**
 * Human-readable table of every subject and its semantics. The gateway serves
 * this at /api/topology so the dashboard can render the real subject map
 * rather than a picture of one.
 */
export const SUBJECT_TABLE = [
  { subject: CTRL.PREPARE, from: 'gateway', to: 'worker', semantics: 'PLAIN', why: 'every worker must arm' },
  { subject: CTRL.READY, from: 'worker', to: 'gateway', semantics: 'PLAIN', why: 'quorum barrier ack' },
  { subject: CTRL.GO, from: 'gateway', to: 'worker', semantics: 'PLAIN', why: 'synchronised start at T0' },
  { subject: CTRL.STOP, from: 'gateway', to: 'worker', semantics: 'PLAIN', why: 'kill switch reaches all' },
  { subject: CTRL.SETPOINT, from: 'gateway', to: 'worker', semantics: 'PLAIN', why: 'live autopilot retarget' },
  { subject: TELEMETRY.SAMPLE, from: 'worker', to: 'collector', semantics: 'QUEUE', why: 'ingest scales, no double count' },
  { subject: TELEMETRY.HELLO, from: 'worker', to: 'gateway+collector', semantics: 'PLAIN', why: 'fleet census everywhere' },
  { subject: TELEMETRY.WATERMARK, from: 'collector', to: 'gateway', semantics: 'PLAIN', why: 'backpressure gauge' },
  { subject: STREAM_RUNS_SUBJECTS, from: 'all', to: 'JetStream', semantics: 'STREAM', why: 'durable system of record' },
  { subject: UI.BROADCAST, from: 'collector', to: 'gateway', semantics: 'PLAIN', why: 'every SSE server gets every frame' },
  { subject: CHAOS.COMMAND, from: 'gateway', to: 'chaos', semantics: 'QUEUE', why: 'one injector acts once' },
  { subject: ORACLE.OBSERVE, from: 'collector', to: 'oracle', semantics: 'QUEUE', why: 'one predictor per tick' },
  { subject: SUITE.START, from: 'gateway', to: 'scheduler', semantics: 'PLAIN', why: 'single scheduler, low volume' },
];
