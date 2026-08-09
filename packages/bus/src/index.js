/**
 * The bus. One connection helper, one JetStream bootstrap, one publish path.
 *
 * Everything in ScaleScope talks through this module so that reconnect
 * behaviour, codec choice and stream configuration exist in exactly one place.
 */

import { connect, JSONCodec, AckPolicy, RetentionPolicy, DiscardPolicy, StorageType } from 'nats';
import {
  STREAM_RUNS,
  STREAM_RUNS_SUBJECTS,
  evt,
  envelope,
  UI,
} from '@scalescope/contracts';
import { log } from '@scalescope/telemetry';

export const jc = JSONCodec();

const NATS_URL = process.env.NATS_URL
  || (process.env.nats_hostname ? `nats://${process.env.nats_hostname}:4222` : 'nats://nats:4222');

/**
 * Connect with settings tuned for a fleet that scales underneath you:
 * infinite reconnect, jittered backoff, and a name so `nats server report
 * connections` is readable when you're debugging at hour six.
 */
export async function connectBus(name) {
  const nc = await connect({
    servers: NATS_URL,
    name: `scalescope-${name}`,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 500,
    reconnectJitter: 500,
    pingInterval: 10_000,
  });

  log.info(`bus connected to ${NATS_URL} as ${name}`);

  (async () => {
    for await (const s of nc.status()) {
      if (s.type === 'disconnect' || s.type === 'reconnect') {
        log.warn(`bus ${s.type}`, s.data);
      }
    }
  })().catch(() => {});

  return nc;
}

/**
 * Ensure the run event stream exists. Idempotent, so every service can call it
 * on boot and whichever wins the race is fine.
 *
 * Retention is limits-based with a hard message and age cap: this is a
 * hackathon deployment on a fixed budget, and an unbounded stream is the kind
 * of thing that quietly fills a disk on day three of judging.
 */
export async function ensureStreams(nc) {
  const jsm = await nc.jetstreamManager();
  const config = {
    name: STREAM_RUNS,
    subjects: [STREAM_RUNS_SUBJECTS],
    retention: RetentionPolicy.Limits,
    discard: DiscardPolicy.Old,
    storage: StorageType.File,
    max_msgs: 2_000_000,
    max_age: 7 * 24 * 60 * 60 * 1_000_000_000, // 7 days in ns
    max_bytes: 1024 * 1024 * 512,              // 512 MB
    duplicate_window: 2 * 60 * 1_000_000_000,
  };

  try {
    await jsm.streams.add(config);
    log.info(`jetstream stream ${STREAM_RUNS} created`);
  } catch (err) {
    if (String(err.message || '').includes('already in use') || err.code === '400') {
      try {
        await jsm.streams.update(STREAM_RUNS, config);
        log.info(`jetstream stream ${STREAM_RUNS} updated`);
      } catch (e) {
        log.warn(`jetstream stream update skipped: ${e.message}`);
      }
    } else {
      throw err;
    }
  }
  return jsm;
}

/**
 * Append an event to a run's log. Uses a deterministic message id so a retry
 * after a flaky ack doesn't duplicate the event inside the duplicate window.
 */
export async function appendEvent(js, runId, type, data, producer, seqHint) {
  const env = envelope(runId, type, data, producer);
  const msgID = seqHint != null ? `${runId}:${type}:${seqHint}` : undefined;
  return js.publish(evt(runId, type), jc.encode(env), msgID ? { msgID } : undefined);
}

/** Core-NATS publish helper with encoding baked in. */
export function pub(nc, subject, data) {
  nc.publish(subject, jc.encode(data));
}

/**
 * Push something to every connected browser, everywhere.
 *
 * This is PLAIN pub/sub on purpose. Each gateway container subscribes and
 * writes to the SSE clients it personally holds, which means the gateway can
 * scale horizontally and no dashboard ever misses a frame just because a
 * different container ingested it. It is the small piece of design that makes
 * the whole control plane stateless.
 */
export function broadcast(nc, event, data) {
  pub(nc, UI.BROADCAST, { event, data, at: Date.now() });
}

/**
 * Subscribe helper that decodes, guards against a single bad message killing
 * the iterator, and logs the handler error with the subject attached.
 */
export function subscribe(nc, subject, handler, opts = {}) {
  const sub = nc.subscribe(subject, opts.queue ? { queue: opts.queue } : undefined);
  (async () => {
    for await (const m of sub) {
      try {
        await handler(jc.decode(m.data), m);
      } catch (err) {
        log.error(`handler failed on ${subject}: ${err.message}`);
      }
    }
  })().catch((err) => log.error(`subscription ${subject} died: ${err.message}`));
  return sub;
}

export { evt, envelope, AckPolicy };
