import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '@scalescope/telemetry';

/**
 * Zerops injects cross-service env vars as `{hostname}_{KEY}`, so a Postgres
 * service with hostname `db` gives you `db_connectionString`. We accept that
 * first and fall back to a plain DATABASE_URL for local development.
 */
const CONNECTION_STRING = process.env.db_connectionString
  || process.env.DATABASE_URL
  || null;

export const pgPool = CONNECTION_STRING
  ? new pg.Pool({
      connectionString: CONNECTION_STRING,
      max: Number(process.env.PG_POOL_MAX || 8),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
    })
  : null;

if (pgPool) {
  pgPool.on('error', (err) => log.error(`pg pool error: ${err.message}`));
}

export function requirePg() {
  if (!pgPool) throw new Error('postgres not configured: set db_connectionString or DATABASE_URL');
  return pgPool;
}

/**
 * Migrations are numbered files applied once and recorded. Every service can
 * safely call this on boot -- the advisory lock means whichever container wins
 * the race applies them and the others wait, rather than eight services racing
 * to CREATE TABLE simultaneously on a cold project.
 */
export async function runPostgresMigrations(dir) {
  const pool = requirePg();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(4823119)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query('SELECT name FROM _migrations');
    const applied = new Set(rows.map((r) => r.name));

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log.info(`postgres migration applied: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(4823119)').catch(() => {});
    client.release();
  }
}

export async function withTx(fn) {
  const client = await requirePg().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
