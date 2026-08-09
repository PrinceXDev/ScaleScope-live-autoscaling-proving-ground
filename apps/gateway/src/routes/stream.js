/**
 * Server-Sent Events.
 *
 * There is exactly one subscription to UI.BROADCAST per gateway container, made
 * once at module scope, and it writes to every response object that container
 * happens to be holding. That arrangement is the reason the gateway is
 * horizontally scalable at all.
 *
 * The alternative -- keeping the connected-client set in one process and having
 * that process also be the only consumer of telemetry -- is what most versions
 * of this project would do, and it works right up until the control plane runs
 * two containers. Then half the samples are ingested by a container that no
 * browser is connected to, the other half by a container serving half the
 * browsers, and the dashboard silently shows a fraction of reality. Nothing
 * errors. The numbers are just wrong.
 *
 * PLAIN pub/sub on the broadcast subject removes the failure mode structurally:
 * every gateway container receives every frame, and each one serves the clients
 * it personally holds. No shared client registry, no sticky sessions, no
 * coordination.
 */

import { Router } from 'express';
import { UI } from '@scalescope/contracts';
import { subscribe } from '@scalescope/bus';
import { log } from '@scalescope/telemetry';
import { replayRun, normaliseSpeed } from '../replay.js';

/** Every live SSE response this container is holding. */
const clients = new Set();

/**
 * Heartbeat interval. Proxies and load balancers close connections they believe
 * to be idle, and an SSE stream during a quiet period looks exactly like an idle
 * connection. A comment line every 20 seconds is invisible to EventSource and
 * keeps every intermediary convinced the socket is alive.
 */
const KEEPALIVE_MS = 20_000;

function writeEvent(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

export function initStream(nc) {
  subscribe(nc, UI.BROADCAST, ({ event, data }) => {
    for (const client of clients) {
      // A client that asked for one run's frames should not receive another's.
      // This matters during a scheduler suite, where runs follow each other
      // closely and a permalink viewer would otherwise see the next experiment
      // bleed into the chart they opened.
      if (client.runId && data?.runId && data.runId !== client.runId) continue;
      if (!writeEvent(client.res, event, data)) clients.delete(client);
    }
  });

  const timer = setInterval(() => {
    for (const client of clients) {
      try { client.res.write(': keepalive\n\n'); } catch { clients.delete(client); }
    }
  }, KEEPALIVE_MS);
  timer.unref?.();

  log.info('sse broadcast bridge attached');
}

export function streamRoutes(ctx) {
  const router = Router();

  router.get('/api/stream', async (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx and several CDNs buffer proxied responses by default, which turns
      // a live stream into a stream that arrives in one lump when the run ends.
      // This header is the documented opt-out and costs nothing when no proxy
      // is present.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    // Tells EventSource how long to wait before reconnecting. Without it the
    // browser default is used, which is longer than a run.
    res.write('retry: 3000\n\n');
    res.write(': connected\n\n');

    const runId = typeof req.query.runId === 'string' ? req.query.runId : null;
    const wantsReplay = req.query.replay === '1' || req.query.replay === 'true';

    if (wantsReplay && runId) {
      // A replay is a private stream: this response is fed exclusively by the
      // replay engine and is never added to the broadcast set, so a live run
      // starting mid-replay cannot interleave frames into it.
      let open = true;
      req.on('close', () => { open = false; });

      try {
        await replayRun({
          nc: ctx.nc,
          runId,
          speed: normaliseSpeed(req.query.speed),
          send: (event, data) => writeEvent(res, event, data),
          isOpen: () => open,
        });
      } catch (err) {
        log.error(`replay ${runId} failed: ${err.message}`);
        writeEvent(res, 'replay.end', { runId, error: 'replay failed', degraded: true });
      }
      res.end();
      return;
    }

    const client = { res, runId };
    clients.add(client);
    req.on('close', () => clients.delete(client));
  });

  return router;
}

export const streamClientCount = () => clients.size;
