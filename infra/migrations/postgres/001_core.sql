-- ScaleScope write model.
--
-- This is the transactional side of the CQRS split: run definitions, the run
-- registry, and experiment suites. Low volume, heavily joined, and the place
-- where "what was this run configured to do" has to be exactly right.
--
-- Observed samples deliberately do NOT live here -- they go to ClickHouse.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  profile           text NOT NULL DEFAULT 'spike',
  target_url        text NOT NULL DEFAULT 'http://target:3000/work',
  rounds            int  NOT NULL DEFAULT 12000,
  max_concurrency   int  NOT NULL DEFAULT 40,
  duration_s        int  NOT NULL DEFAULT 90,
  cooldown_s        int  NOT NULL DEFAULT 90,
  slo_p95_ms        int  NOT NULL DEFAULT 500,
  setpoint_ms       int,
  chaos             jsonb,

  status            text NOT NULL DEFAULT 'pending',
  suite_id          uuid,
  suite_step        int,

  t0_ms             bigint,
  started_at        timestamptz,
  ended_at          timestamptz,

  -- Denormalised results, written once at run completion by folding the event
  -- log. Keeping them here means the history list is one cheap query instead of
  -- a ClickHouse aggregate per row.
  peak_containers   int,
  peak_rps          int,
  peak_p95_ms       real,
  min_p95_ms        real,
  time_to_recover_s real,
  container_seconds real,
  total_requests    bigint,
  total_errors      bigint,
  est_cost_usd      numeric(10, 6),
  linearity         real,

  is_showcase       boolean NOT NULL DEFAULT false,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runs_started_idx  ON runs (started_at DESC);
CREATE INDEX IF NOT EXISTS runs_status_idx   ON runs (status);
CREATE INDEX IF NOT EXISTS runs_suite_idx    ON runs (suite_id, suite_step);
CREATE INDEX IF NOT EXISTS runs_showcase_idx ON runs (is_showcase) WHERE is_showcase;

-- Experiment suites: an ordered list of run configs executed unattended by the
-- scheduler, with cooldown between steps. This is what turns "I ran two tests
-- and compared them by hand" into "I swept a config space".
CREATE TABLE IF NOT EXISTS suites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  kind          text NOT NULL DEFAULT 'manual',   -- manual | envelope | knee | regression
  steps         jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  current_step  int  NOT NULL DEFAULT 0,
  result        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  ended_at      timestamptz
);

CREATE INDEX IF NOT EXISTS suites_status_idx ON suites (status, created_at DESC);

-- The twin's learned parameters, persisted so knowledge accumulates across runs
-- instead of resetting every time the oracle container restarts.
CREATE TABLE IF NOT EXISTS twin_params (
  target_key    text PRIMARY KEY,
  params        jsonb NOT NULL,
  samples       int NOT NULL DEFAULT 0,
  mean_abs_err  real,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Container lifecycle, reconstructed entirely from HTTP response headers.
-- One row per container ScaleScope ever observed serving traffic. No platform
-- API, no credentials -- just X-Instance-Id and X-Instance-Age coming back over
-- the wire. This table is what the swimlane chart renders.
CREATE TABLE IF NOT EXISTS instances (
  run_id        uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  instance_id   text NOT NULL,
  first_seen_ms bigint NOT NULL,
  last_seen_ms  bigint NOT NULL,
  boot_ms       bigint,
  requests      bigint NOT NULL DEFAULT 0,
  peak_p95_ms   real,
  PRIMARY KEY (run_id, instance_id)
);
