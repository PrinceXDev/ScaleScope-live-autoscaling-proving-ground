import fs from 'node:fs';
import path from 'node:path';
import { log } from '@scalescope/telemetry';

/**
 * ClickHouse over its HTTP interface on 8123.
 *
 * Deliberately no native driver. The HTTP interface takes SQL in the query
 * string and a body in whatever format you name, which covers everything this
 * project needs, and it removes an entire class of dependency and protocol
 * problems from a build with a deadline. `fetch` is in the runtime already.
 */

const HOST = process.env.CLICKHOUSE_URL
  || (process.env.metrics_hostname ? `http://${process.env.metrics_hostname}:8123` : 'http://metrics:8123');

const USER = process.env.metrics_user || process.env.CLICKHOUSE_USER || 'default';
const PASSWORD = process.env.metrics_password || process.env.CLICKHOUSE_PASSWORD || '';

function authHeaders() {
  const h = {};
  if (USER) h['X-ClickHouse-User'] = USER;
  if (PASSWORD) h['X-ClickHouse-Key'] = PASSWORD;
  return h;
}

export async function chQuery(sql, body, { timeoutMs = 15_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${HOST}/?query=${encodeURIComponent(sql)}`, {
      method: 'POST',
      headers: authHeaders(),
      body,
      signal: ctl.signal,
    });
    if (!res.ok) {
      throw new Error(`clickhouse ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Run a SELECT and get parsed rows back. Always appends FORMAT JSON. */
export async function chJson(sql, params = {}) {
  const bound = bindParams(sql, params);
  const res = await chQuery(`${bound} FORMAT JSON`);
  const json = await res.json();
  return json.data || [];
}

/**
 * Minimal, strict parameter binding.
 *
 * ClickHouse's HTTP interface does support server-side parameters, but the
 * escaping rules differ enough between versions that a build weekend is the
 * wrong time to discover an edge case. Instead every value is type-checked and
 * serialised here, and anything that is not a number, a boolean, or a string
 * matching a strict identifier/UUID pattern is rejected outright rather than
 * escaped. Rejecting is safer than escaping when the input surface is this
 * small.
 */
const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,128}$/;

export function bindParams(sql, params) {
  return sql.replace(/:(\w+)/g, (match, key) => {
    if (!(key in params)) throw new Error(`missing clickhouse param :${key}`);
    const v = params[key];
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error(`non-finite param :${key}`);
      return String(v);
    }
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (typeof v === 'string') {
      if (!SAFE_STRING.test(v)) throw new Error(`unsafe clickhouse param :${key}`);
      return `'${v}'`;
    }
    throw new Error(`unsupported clickhouse param type for :${key}`);
  });
}

/**
 * Batched insert. Never call this per row -- ClickHouse is a columnar store and
 * a per-row insert creates a part per row, which degrades into a merge storm
 * within a couple of minutes of real traffic. The collector accumulates for one
 * second and sends one body.
 */
export async function chInsert(table, rows) {
  if (!rows.length) return 0;
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  await chQuery(`INSERT INTO ${table} FORMAT JSONEachRow`, body);
  return rows.length;
}

export async function ensureClickhouse(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const stmt of sql.split(';').map((s) => stripComments(s).trim()).filter(Boolean)) {
      await chQuery(stmt);
    }
    log.info(`clickhouse migration applied: ${file}`);
  }
}

const stripComments = (s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
