/**
 * Gateway client.
 *
 * Base URL is resolved at runtime from /config.json (see index.html for why),
 * with a same-origin fallback so a missing or empty config still works when the
 * gateway sits behind the same domain.
 */

let base = '';
let oracleBase = '';
let ready = null;

export function apiBase() { return base; }

export function initApi() {
  if (ready) return ready;
  ready = fetch('/config.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))
    .then((cfg) => {
      base = (cfg.apiUrl || '').replace(/\/$/, '');
      oracleBase = (cfg.oracleUrl || '').replace(/\/$/, '');
      window.__SCALESCOPE__ = { apiUrl: base, oracleUrl: oracleBase, loaded: true };
      return base;
    });
  return ready;
}

async function req(path, opts = {}) {
  await initApi();
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  topology:      ()            => req('/api/topology'),
  budget:        ()            => req('/api/budget'),
  listRuns:      (limit = 50)  => req(`/api/runs?limit=${limit}`),
  getRun:        (id)          => req(`/api/runs/${id}`),
  showcase:      ()            => req('/api/runs/showcase'),
  timeline:      (id)          => req(`/api/runs/${id}/timeline`),
  instances:     (id)          => req(`/api/runs/${id}/instances`),
  compare:       (a, b)        => req(`/api/compare?a=${a}&b=${b}`),
  startRun:      (config)      => req('/api/runs', { method: 'POST', body: config }),
  stopRun:       (id)          => req(`/api/runs/${id}/stop`, { method: 'POST' }),
  setpoint:      (id, ms)      => req(`/api/runs/${id}/setpoint`, { method: 'POST', body: { setpointMs: ms } }),
  chaos:         (id, body)    => req(`/api/runs/${id}/chaos`, { method: 'POST', body }),
  listSuites:    ()            => req('/api/suites'),
  getSuite:      (id)          => req(`/api/suites/${id}`),
  startSuite:    (body)        => req('/api/suites', { method: 'POST', body }),
  envelope:      ()            => req('/api/envelope'),
  markShowcase:  (id)          => req(`/api/runs/${id}/showcase`, { method: 'POST' }),
};

/**
 * Oracle client — a separate service, a separate base URL.
 *
 * Oracle's HTTP layer serves every response with `Access-Control-Allow-Origin:
 * *` deliberately (read-only, no credentials, no auth) so the dashboard can
 * call it directly rather than routing prediction data through the gateway
 * for no reason. See apps/oracle/src/index.js for the reasoning.
 */
async function oracleReq(path) {
  await initApi();
  if (!oracleBase) throw new Error('oracleUrl not configured in config.json');
  const res = await fetch(`${oracleBase}${path}`);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const oracleApi = {
  params:   ()                  => oracleReq('/params'),
  accuracy: (runId, limit = 200) => oracleReq(`/accuracy?${new URLSearchParams({ ...(runId ? { runId } : {}), limit })}`),
};

/**
 * Live event stream.
 *
 * The gateway emits exactly the same event names for a live run and for a
 * replayed one, which is the point: this function is used unchanged by the
 * console, by the permalink replay view and by the story page's playback
 * fallback. Nothing downstream can tell the difference.
 *
 * @param {(event: string, data: any) => void} onEvent
 * @param {{ runId?: string, replay?: boolean, speed?: number }} opts
 */
export function openStream(onEvent, opts = {}) {
  let es = null;
  let closed = false;
  let retry = 0;

  const connect = async () => {
    await initApi();
    if (closed) return;

    const params = new URLSearchParams();
    if (opts.runId) params.set('runId', opts.runId);
    if (opts.replay) params.set('replay', '1');
    if (opts.speed) params.set('speed', String(opts.speed));

    es = new EventSource(`${base}/api/stream${params.toString() ? `?${params}` : ''}`);

    for (const name of [
      'tick', 'run.created', 'run.armed', 'run.started', 'run.completed',
      'run.failed', 'scaled', 'phase', 'chaos', 'prediction', 'slo',
      'worker.hello', 'watermark', 'suite.progress', 'replay.end',
    ]) {
      es.addEventListener(name, (e) => {
        retry = 0;
        try { onEvent(name, JSON.parse(e.data)); } catch { /* keep the stream alive */ }
      });
    }

    es.onerror = () => {
      // EventSource reconnects on its own for transient failures, but a replay
      // stream that has ended should not be resurrected - the server closes it
      // deliberately after the last frame.
      if (closed || opts.replay) { es?.close(); return; }
      retry += 1;
      if (retry > 6) { es.close(); setTimeout(connect, 5000); }
    };
  };

  connect();

  return () => { closed = true; es?.close(); };
}
