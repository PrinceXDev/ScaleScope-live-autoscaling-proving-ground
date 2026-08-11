# What was actually tested, and how

Every backend file passed `node --check` (syntax only). That's necessary and
not remotely sufficient, so before calling anything "workable" the full
pipeline was run for real, locally, against real infrastructure — not mocked.

## Local infra used

- `nats-server` (JetStream enabled) — downloaded and run directly, no Docker
  available in this environment.
- Postgres 16 and Redis (Valkey-compatible) — both already present in this
  sandbox, started directly.
- ClickHouse — **not available locally** and deliberately left unreachable
  for this pass, specifically to prove the "ClickHouse is best-effort at boot"
  design decision actually holds under a real failure rather than just reading
  correctly in the source. It did: gateway and collector both logged a warning
  and kept running. This is the one gap in this test — the ClickHouse-backed
  paths (`/api/runs/:id/timeline`, `/api/runs/:id/instances`, `/api/compare`,
  replay-from-timeline) are code-reviewed and syntax-checked but not yet
  exercised against a live ClickHouse. Worth a first pass after import,
  before you rely on the Lab view or a permalink replay for a demo.

## What was run, and what it proved

**A full run through the two-phase barrier.** `POST /api/runs` → the gateway
broadcasts PREPARE, the worker warms its connection pool and acks READY, the
gateway broadcasts GO with an absolute T0, the worker's bucket clock aligns to
it. Confirmed in logs: `worker warmed`, then `run started`, matching
timestamps within milliseconds.

**Live SSE delivery.** Connected to `/api/stream?runId=...` mid-run and
captured real `tick` and `scaled` events over the wire, in the exact
`TickFrame` shape the frontend store expects — including the container count
flipping from 0 to 1 the instant the target's first response carried an
`X-Instance-Id`.

**Run finalisation.** Confirmed the event log folds correctly into a Postgres
summary row — peak containers, total requests, estimated cost — via
`GET /api/runs/:id` after completion.

**The credit budget and single-run lock.** `GET /api/budget` correctly
tracked `used: 4` after four runs; a second `POST /api/runs` while one was
active would have hit the Valkey lock (not separately re-tested this pass,
but the lock/budget code paths were exercised on every run above without
failure).

**Chaos injection, end to end, including the auth failure mode.** First
attempt correctly returned a 403 because the test target didn't have
`CHAOS_SECRET` set — proving the timing-safe auth check rejects by default
rather than failing open. Second attempt, with the secret set on both sides,
landed a real `degrade` command on the target and was annotated onto the run's
event log.

**The oracle's cold-start safety.** The digital twin correctly refused to
persist its learned parameters after runs with fewer than 20 observed ticks
(`frames=18`, `frames=14`, `frames=2` in the logs), logging exactly why. This
is a real guard against a handful of noisy samples corrupting a model that
future runs rely on — and it fired without being specifically prompted to.

**The web build.** `npm run build:web` completes cleanly, code-splits GSAP,
uPlot, and React into separate chunks as configured, and produces a working
`dist/`.

## Two real bugs this caught (already fixed in the source you have)

1. **Every single run would have failed on the very first `POST /api/runs`.**
   A Postgres update statement used one placeholder in two type contexts
   (`t0_ms` as bigint, `to_timestamp()` as numeric) without a cast, and
   `node-postgres` throws rather than guessing. Caught immediately by the
   first real run attempt. Fixed in `apps/gateway/src/orchestrator.js`.

2. **Every log line from every service was tagged `[svc]`** instead of its
   real service name, because `SCALESCOPE_SERVICE` was cached at module-load
   time in `packages/telemetry`, but every entry point sets that env var
   *after* its imports resolve — which, in ES modules, is already too late.
   Harmless to correctness, brutal for debugging a live demo with eight
   services' logs interleaved. Fixed by reading the env var fresh on every log
   call instead of caching it.

3. **The architecture panel would show the gateway itself as "unknown" ten
   seconds after every page load** — a heartbeat-reconciliation loop was
   overwriting the gateway's and NATS's directly-checked status with a
   heartbeat lookup that nothing ever populates for those two services. Fixed
   by excluding them from the heartbeat table and re-asserting their direct
   checks every poll tick.

None of these three would have been caught by reading the code carefully,
which is exactly why the run happened before writing this file rather than
after.

## What to test next, in order of how much it'd embarrass you if skipped

1. Deploy `metrics` (ClickHouse) for real and hit `/api/runs/:id/timeline`
   and `/api/compare` against a completed run — the queries are
   code-reviewed, not yet run against a live ClickHouse.
2. A full replay via `?replay=1` against a run whose event log is still in
   JetStream, to confirm pacing behaves — logic is straightforward but
   untested live.
3. A `kill` chaos command against a real multi-container `target` on Zerops
   (locally there was only ever one container, so `kill` was code-reviewed but
   not fired).
4. One scheduler suite (`kind: 'manual'` with two steps is the simplest) run
   against the deployed gateway, to confirm the suite's own budget guard and
   its polling-based wait-for-completion behave over a real network hop
   rather than localhost.
