/**
 * Worker wiring: NATS in, NATS out, everything else delegated to LoadFleet.
 *
 * This file's only job is to decide what a subject is. The load-generation
 * logic -- the barrier handshake, the bucket clock, the histogram bookkeeping,
 * the cooldown probe -- all lives in fleet.js and knows nothing about NATS,
 * which is what makes it possible to reason about in isolation.
 */

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { CTRL, TELEMETRY } from '@scalescope/contracts';
import { connectBus, pub, subscribe } from '@scalescope/bus';
import { log } from '@scalescope/telemetry';
import { LoadFleet } from './fleet.js';

process.env.SCALESCOPE_SERVICE = 'worker';

const WORKER_ID = randomUUID().slice(0, 8);
const PORT = Number(process.env.PORT || 3000);
const HELLO_INTERVAL_MS = 5000;

async function main() {
  log.info(`booting worker ${WORKER_ID}`);
  const nc = await connectBus(`worker-${WORKER_ID}`);

  const fleet = new LoadFleet({
    workerId: WORKER_ID,
    publishSample: (sample) => pub(nc, TELEMETRY.SAMPLE, sample),
    onPhase: (phase, detail) => log.debug(`phase -> ${phase}`, detail),
  });

  // Heartbeat is PLAIN, not queued: both the gateway (fleet census on the
  // topology panel) and the collector (which does not otherwise know how many
  // workers exist, only how many have sent a sample recently) need to see
  // every worker's heartbeat independently.
  setInterval(() => {
    pub(nc, TELEMETRY.HELLO, { workerId: WORKER_ID, at: Date.now(), status: fleet.status() });
  }, HELLO_INTERVAL_MS).unref?.();

  // ---- barrier: phase one ---------------------------------------------------
  subscribe(nc, CTRL.PREPARE, async (msg) => {
    if (!msg?.config?.targetUrl) return;
    await fleet.prepare(msg.config.targetUrl);
    pub(nc, CTRL.READY, { runId: msg.runId, workerId: WORKER_ID, at: Date.now() });
  });

  // ---- barrier: phase two ---------------------------------------------------
  subscribe(nc, CTRL.GO, (msg) => {
    if (!msg?.runId || !msg?.t0 || !msg?.config) return;
    fleet.start(msg);
  });

  subscribe(nc, CTRL.STOP, (msg) => {
    if (msg?.runId && msg.runId !== fleet.runId) return;
    fleet.stop('operator');
  });

  subscribe(nc, CTRL.SETPOINT, (msg) => {
    if (msg?.runId && msg.runId !== fleet.runId) return;
    fleet.retarget(Number(msg.setpointMs));
  });

  http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'worker', ...fleet.status() }));
      return;
    }
    res.writeHead(404).end();
  }).listen(PORT, () => log.info(`worker ${WORKER_ID} healthz on ${PORT}`));

  log.info(`worker ${WORKER_ID} ready`);
}

main().catch((err) => {
  log.error(`fatal worker startup error: ${err.stack || err.message}`);
  process.exit(1);
});
