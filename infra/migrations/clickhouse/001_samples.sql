-- ScaleScope read model.
--
-- Append-only observed samples. One row per (run, second, worker, target
-- instance). Never updated, never deleted individually, queried exclusively by
-- aggregate over a time range.
--
-- LowCardinality on worker_id and target_instance is the load-bearing choice:
-- both are 8-character ids drawn from a set that is at most a few dozen wide,
-- so ClickHouse dictionary-encodes them. uniqExact(target_instance) -- the
-- query that produces the container curve -- then becomes a scan over a
-- dictionary-encoded column rather than over strings.
--
-- TTL keeps a hackathon deployment from quietly filling a disk during judging.

CREATE TABLE IF NOT EXISTS samples (
  run_id          String,
  ts              DateTime64(3),
  t               Int32,                              -- seconds since T0
  phase           LowCardinality(String),             -- load | cooldown
  worker_id       LowCardinality(String),
  target_instance LowCardinality(String),
  instance_age_ms UInt64,
  requests        UInt32,
  errors          UInt32,
  concurrency     UInt32,
  p50_ms          Float32,
  p95_ms          Float32,
  p99_ms          Float32,
  setpoint_ms     Float32
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (run_id, t, target_instance)
TTL toDateTime(ts) + INTERVAL 30 DAY;

-- Per-second fleet rollup. This is the exact query the replay endpoint runs,
-- kept here as a view so the SQL that produces the chart is defined once.
--
-- uniqExact(target_instance) is the whole autoscaling curve in one expression:
-- how many distinct containers answered in this second. Empirically observed,
-- never self-reported by the platform.
CREATE VIEW IF NOT EXISTS run_timeline AS
SELECT
  run_id,
  t,
  any(phase)                          AS phase,
  sum(requests)                       AS rps,
  sum(errors)                         AS errors,
  max(p95_ms)                         AS p95,
  max(p99_ms)                         AS p99,
  round(
    sum(p50_ms * requests) / nullIf(sum(requests), 0)
  )                                   AS p50,
  uniqExact(target_instance)          AS containers,
  uniqExact(worker_id)                AS workers,
  sum(concurrency)                    AS concurrency,
  any(setpoint_ms)                    AS setpoint_ms
FROM samples
GROUP BY run_id, t;

-- Per-container attribution within a run. Drives the lifecycle swimlane's
-- request-share shading and answers "did the new container actually take
-- traffic, or did it come up and sit idle?" -- which is a real failure mode and
-- one you cannot see from a container count alone.
CREATE VIEW IF NOT EXISTS run_instances AS
SELECT
  run_id,
  target_instance,
  min(t)                AS first_t,
  max(t)                AS last_t,
  sum(requests)         AS requests,
  max(p95_ms)           AS peak_p95,
  max(instance_age_ms)  AS max_age_ms
FROM samples
WHERE target_instance != '__unreachable__'
GROUP BY run_id, target_instance;
