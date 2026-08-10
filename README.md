# ScaleScope

A live autoscaling proving ground, built on and about Zerops. ScaleScope fires
controlled load at a service and shows Zerops autoscaling in real time —
container count, latency, and throughput streaming live, with every run
replayable afterwards, a digital twin predicting what happens next, and
unattended experiment suites that turn one run into a swept curve.

**Status:** the full backend is built and has been run end to end against real
infrastructure (see `TESTING.md`). The web console is built and builds
cleanly. See `DEPLOY.md` for the fastest path to a live, public demo, and the
"what's next" section below for what's genuinely still in progress.

## Architecture

Twelve services. Every one is load-bearing — none is here to pad the count.

| Service     | Type       | Role                                                                      |
| ----------- | ---------- | ------------------------------------------------------------------------- |
| `web`       | static     | Story (landing), live Console, and the Lab (envelope/compare)             |
| `gateway`   | nodejs     | Control plane — admission, the two-phase start barrier, SSE fan-out, REST |
| `collector` | nodejs     | Ingest — merges fleet samples into tick frames, writes ClickHouse         |
| `worker`    | nodejs     | Load fleet — fires the profile, or runs the latency-target autopilot      |
| `target`    | nodejs     | The service under test — this is what Zerops scales                       |
| `oracle`    | nodejs     | Autoscaler digital twin — predicts the container count ~15s ahead         |
| `chaos`     | nodejs     | Fault injector — kill / degrade / partition the target on command         |
| `scheduler` | nodejs     | Runs unattended experiment suites through the gateway's own API           |
| `nats`      | broker     | Commands fan out, telemetry fans in, the run log streams (JetStream)      |
| `db`        | postgresql | Write model — run registry, suites, twin parameters                       |
| `metrics`   | clickhouse | Read model — every observed sample, queried by aggregate                  |
| `cache`     | valkey     | Live materialized view — rolling container window, locks, credit budget   |

```
web (Story / Console / Lab)
  │  SSE (live or replayed — same events, same reducer)
  ▼
gateway ──── PLAIN ────▶ worker (fleet, N containers)
  │ REST + barrier                    │ fires load, measures latency
  │                                   ▼
  │                                 target  ◀── Zerops scales this
  │                                   │  X-Instance-Id / X-Instance-Age
  │                                   ▼
  │                          worker measures, publishes samples
  │                                   │ QUEUE
  │                                   ▼
  │                              collector ──▶ ClickHouse (samples)
  │                                   │ merged tick frames
  │                                   ├──▶ oracle (prediction)
  │                                   └──▶ gateway ──▶ SSE broadcast
  ▼
Postgres (run registry) ◀── folded from the JetStream event log at finalisation
```

Every run is an append-only event log on JetStream — `created`, `armed`,
`started`, one `tick` per second, `scaled`, `slo`, `chaos`, `prediction`,
`completed`. Postgres, ClickHouse, and Valkey are each a purpose-built
projection of that log, not three independent sources of truth (see
`packages/contracts/src/events.js`). Replay re-emits the same log at its
original pace into the same SSE pipe live traffic uses — the frontend has no
code path that knows whether it's watching now or three hours ago.

## Repo layout

```
apps/
  gateway/    control plane: orchestrator, replay engine, REST, SSE, topology
  collector/  ingest: bucket watermarking, container window, SLO/scale detection
  worker/     load fleet: LoadFleet engine (fleet.js) + NATS wiring (index.js)
  target/     the service under test
  oracle/     autoscaler digital twin (online parameter estimation, not ML)
  chaos/      fault injector
  scheduler/  unattended experiment suites (knee search, envelope sweep, regression)
  web/        React + Vite dashboard — Story, Console, Lab
packages/
  contracts/  subjects, event catalog, TickFrame shape, load profiles — the
              single source of truth every service imports rather than
              hand-typing a subject string or event shape
  bus/        NATS connect/subscribe/publish/broadcast helpers, JetStream bootstrap
  stores/     Postgres, ClickHouse (HTTP), Valkey clients + the invariants
              that live in each (run lock, credit budget, rolling window)
  control/    LatencyAutopilot (PID), AutoscalerTwin, capacity-envelope solver
  telemetry/  logging, the shared bucket clock, LatencyHistogram, InstanceWindow
infra/
  migrations/postgres/    write-model schema
  migrations/clickhouse/  read-model schema + the views the API queries
zerops.yaml                 one file, one setup per service (npm workspaces monorepo)
zerops-project-import.yaml  the whole project, one file
```

## The two technical tricks that make it work

**Force horizontal scaling, not vertical.** Zerops scales vertically first —
more CPU inside the container — and only adds containers once that ceiling is
hit. `target`'s vertical ceiling is capped low and set to **dedicated** CPU
mode (Zerops' own docs: the horizontal-trigger CPU thresholds apply to
dedicated CPU only), and the `/work` endpoint burns real CPU via
`crypto.pbkdf2Sync`, tunable by a `rounds` parameter.

**Count containers without a privileged API.** Every `target` container mints
a UUID at boot and returns it in `X-Instance-Id`. Distinct IDs in a rolling
ten-second window is the live container count — measured, not self-reported,
and it needs no platform token. `X-Instance-Age` additionally lets the system
reconstruct a full container lifecycle swimlane from HTTP headers alone.

## What's genuinely still in progress

- The story page is a hero + live attract-mode replay, not yet the full
  scroll-scrubbed narrative (Lenis + ScrollTrigger scrubbing a recorded run as
  you scroll a pinned section). The scaffolding for it is registered and ready
  in `apps/web/src/motion/gsap.js`.
- The Lab view's suite runner works (`scheduler` executes knee/envelope/manual/
  regression suites through the gateway's own API) but its live progress isn't
  yet wired to a progress bar in the UI — check `GET /api/runs` meanwhile.
- ClickHouse-backed reads (`timeline`, `instances`, `compare`, degraded replay)
  are code-reviewed and syntax-checked but not yet run against a live
  ClickHouse — see `TESTING.md` for exactly what has and hasn't been verified.

None of the above blocks a live demo of the core claim: start a run, watch the
container count climb and fall, replay it afterwards.

## Running the project

Two ways to run this: **locally**, against Docker containers standing in for
Zerops' managed services, for development and for proving a change works
before you spend a deploy cycle on it — and **on Zerops**, for the real,
public demo. Both are covered in full below. Do the local run first even if
you're in a hurry; it's fifteen minutes and it's what caught the bugs listed
in `TESTING.md` before they reached a live deploy.

### Prerequisites

- **Node.js 22+** and **npm 10+** (`node -v`, `npm -v`). The whole repo is one
  npm-workspaces monorepo — one `npm install` at the root wires every
  `packages/*` dependency into every `apps/*` service via symlinks.
- **Docker** (or Podman with the `docker` CLI shim) and **Docker Compose v2**,
  for local infrastructure only — not for the ScaleScope services themselves,
  which run as plain Node processes.
- For the Zerops half: a **Zerops account**, the **zcli** CLI
  (`npm install -g @zerops/zcli` or see docs.zerops.io for the current install
  command), and a **personal access token** (Zerops GUI → Settings → Access
  Token Management → generate one, then `zcli login <token>`).

### 1. Install dependencies

```bash
git clone <your-repo-url> scalescope   # or unzip scalescope-v2.zip
cd scalescope
npm install
```

One install, from the root, for all twelve `packages/*` and `apps/*`
workspaces at once. If you ever see a service fail to resolve
`@scalescope/contracts` or similar, you ran `npm install` inside a subfolder
instead of the root — delete any stray `node_modules` that created and
reinstall from the root.

### 2. Verify the code parses

```bash
npm run check        # syntax-checks every service and package .js file
npm run build:web     # builds the React dashboard; also type-shakes the JSX side
```

Both should finish clean. This is the fastest possible signal before you
spend time on infrastructure — see `infra/scripts/check-syntax.mjs` for
exactly what it does and doesn't cover.

### 3. Start local infrastructure

```bash
docker compose up -d
```

This brings up NATS (with JetStream enabled), Postgres, a Redis-protocol
cache standing in for Valkey, and ClickHouse — see `docker-compose.yml` for
exactly what and why. Give it about ten seconds; Postgres and ClickHouse both
need a moment before they'll accept connections. Sanity-check with:

```bash
docker compose ps                      # all four should show "healthy" or "running"
curl http://localhost:8222/jsz         # NATS JetStream state — should return JSON, not connection refused
```

### 4. Configure environment variables

```bash
cp .env.example .env
```

The defaults in `.env.example` already match `docker-compose.yml`'s ports, so
nothing needs editing to get started. Load it into your shell before starting
any service:

```bash
set -a; source .env; set +a       # bash/zsh
```

(On Windows PowerShell: `Get-Content .env | ForEach-Object { if ($_ -match '^\s*([^#][^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim()) } }` — or just set the same variables directly in the PowerShell session, or run everything inside WSL where the bash form above works unmodified.)

### 5. Start every service, in this order, each in its own terminal

Order matters a little: `gateway` runs the Postgres migrations on boot, so
give it a moment before starting things that depend on the schema existing —
in practice starting them all within a few seconds of each other is fine,
`gateway`'s migration runs in under 100ms.

```bash
# terminal 1
PORT=$TARGET_PORT npm run start:target

# terminal 2
PORT=$GATEWAY_PORT npm run start:gateway

# terminal 3
PORT=$COLLECTOR_PORT npm run start:collector

# terminal 4
PORT=$WORKER_PORT npm run start:worker

# terminal 5 (optional but recommended — predicts the container count live)
PORT=$ORACLE_PORT npm run start:oracle

# terminal 6 (optional — fault injection)
PORT=$CHAOS_PORT npm run start:chaos

# terminal 7 (optional — unattended experiment suites)
PORT=$SCHEDULER_PORT npm run start:scheduler
```

Each should log a `booting <name>` line followed by `<name> ready` within a
couple of seconds, tagged correctly (`[gateway]`, `[worker]`, etc. — see
`TESTING.md` for why that tag being correct is itself a thing worth checking).
If any service instead logs a stack trace and exits, the infrastructure isn't
reachable yet — re-check step 3 and that `.env` is loaded in _that_ terminal.

### 6. Start the dashboard

```bash
# terminal 8
VITE_API_PROXY=http://localhost:$GATEWAY_PORT npm run dev:web
```

Open the URL Vite prints (typically `http://localhost:5173`). You should see
the Story page load with an entrance animation. It'll say "attract mode" with
nothing playing yet — that's correct, there's no completed run to replay.

### 7. Run something

Either through the UI — go to `#/console`, fill in the run form (Spike
profile, default numbers are fine, 20–30 second duration for a quick check),
click **start run** — or directly against the API, useful for confirming the
whole pipeline without touching the browser:

```bash
curl -s -X POST http://localhost:$GATEWAY_PORT/api/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "first-run",
    "profile": "spike",
    "targetUrl": "http://localhost:'"$TARGET_PORT"'/work",
    "rounds": 4000,
    "maxConcurrency": 8,
    "durationS": 12,
    "cooldownS": 6,
    "sloP95Ms": 500
  }'
```

You should immediately see: the `worker` terminal log `warmed` then `started`;
the `collector` terminal log `scaled 0 -> 1`; and if you're watching the
console, the container count tile move. Locally there's no real autoscaler
underneath `target`, so the count will stay at 1 — that's expected and is
exactly the gap Zerops deployment fills. Confirm the full loop by hitting the
run's summary once it finishes:

```bash
curl -s http://localhost:$GATEWAY_PORT/api/runs | python3 -m json.tool | head -20
```

If that returns your run with a `status: "completed"` and non-null
`peak_containers` / `total_requests`, the entire local pipeline — barrier,
load generation, ingest, event log, finalisation — is working end to end.

### 8. Tear down

```bash
docker compose down -v     # -v also drops the data volumes, for a clean slate next time
```

Ctrl-C each of the eight `npm run start:*` / `dev:web` terminals.

---

### Tuning autoscaling

If `target` isn't scaling under real load:

1. Confirm `cpuMode: DEDICATED` on `target` in the Zerops GUI's scaling
   settings for that service — Zerops' own docs state the horizontal-trigger
   CPU thresholds (`minFreeCpuPercent` and friends) apply to dedicated CPU
   only. This was a real bug in an earlier draft of this project's import
   YAML, so it's worth checking even though the current YAML sets it
   correctly.
2. Raise `rounds` in the run form — this is CPU cost per request. One
   container needs to actually saturate before Zerops has a reason to add
   another; too low and your whole `maxConcurrency` budget doesn't dent it.
3. Check `worker`'s container count in the Zerops GUI — it defaults to
   `minContainers: 2`, which is usually enough fleet to generate real
   pressure, but confirm both worker containers are actually up.
4. If it's still not scaling after real tuning, that's a legitimate fallback
   demo, not a failure: frame it as a distributed load-testing and telemetry
   tool, and note the container panel currently reads 1. Losing twenty
   minutes tuning this is fine. Losing three hours is not — move on.

### Environment variables reference

Set automatically by the project import YAML — no manual step needed unless
you're changing a default:

| Variable            | Service(s)    | Default               | Purpose                                       |
| ------------------- | ------------- | --------------------- | --------------------------------------------- |
| `MAX_RUNS_PER_HOUR` | gateway       | `12`                  | Hard ceiling on runs/hour, enforced in Valkey |
| `SUITE_MAX_RUNS`    | scheduler     | `8`                   | Runs a single suite may spend                 |
| `SUITE_MAX_TOTAL_S` | scheduler     | `900`                 | Wall-clock ceiling on a single suite          |
| `CHAOS_SECRET`      | target, chaos | generated at import   | Shared auth for `/admin/*` on target          |
| `GATEWAY_URL`       | scheduler     | `http://gateway:3000` | Where suites start runs                       |
| `TARGET_ADMIN_URL`  | chaos         | `http://target:3000`  | Where chaos sends fault commands              |
| `NATS_URL`          | all           | `nats://nats:4222`    | Internal hostname, no change needed           |

Injected automatically by Zerops per data-tier service, read directly by
`packages/stores/*` — never needs manual configuration on Zerops:
`db_connectionString`, `cache_connectionString`, `metrics_hostname`.

## Credits

Runs are capped server-side (`durationS` ≤ 180s, `cooldownS` ≤ 180s) and the
gateway enforces an hourly run budget plus a single-active-run lock, both in
Valkey so they hold even if the gateway itself scales. See
`packages/contracts/src/profiles.js` (`LIMITS`) and
`packages/stores/src/valkey.js` (`CreditBudget`, `RunLocks`).
