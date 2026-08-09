/**
 * Three stores, three jobs, one file that explains why.
 *
 * This is CQRS with the event log (JetStream) as the source of truth and each
 * store as a purpose-built projection of it:
 *
 *   Postgres    WRITE MODEL. Run definitions, suites, and the run registry.
 *               Relational, transactional, low volume, joined constantly by the
 *               UI's history and comparison views. A run's config is a fact
 *               that must not be lost or half-written -- that is a database's
 *               job, not a time-series store's.
 *
 *   ClickHouse  READ MODEL. Every observed sample, append-only, queried
 *               exclusively by aggregate over time ranges. Columnar with
 *               LowCardinality on the instance id, so uniqExact over container
 *               identity across a hundred runs is a scan of one narrow column
 *               rather than a row-by-row walk. Putting this in Postgres would
 *               work at hackathon volume and stop working the moment the
 *               scheduler runs nightly suites for a month.
 *
 *   Valkey      LIVE MATERIALIZED VIEW. The rolling instance window, the run
 *               lock, the hourly credit budget. All of it is hot, all of it is
 *               ephemeral, and all of it must be shared across every gateway
 *               and collector container -- which is precisely the state that
 *               cannot live in one process's memory if the control plane is
 *               going to scale horizontally.
 *
 * The honest version of the answer to "why four datastores?" is that they are
 * four projections of one log, each with a different access pattern, and that
 * removing any one of them would force another to do a job it is bad at.
 */

export { pgPool, runPostgresMigrations, withTx } from './postgres.js';
export { chQuery, chInsert, chJson, ensureClickhouse } from './clickhouse.js';
export { valkey, connectValkey, RunLocks, CreditBudget, LiveWindow } from './valkey.js';
