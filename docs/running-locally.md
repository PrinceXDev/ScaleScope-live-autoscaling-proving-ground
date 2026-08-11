# Running the project locally

Two ways to run this: **locally**, against Docker containers standing in for
Zerops' managed services, for development and for proving a change works
before you spend a deploy cycle on it — and **on Zerops**, for the real,
public demo (see [`deploy.md`](./deploy.md)). Do the local run first even if
you're in a hurry; it's fifteen minutes and it's what caught the bugs listed
in [`testing.md`](./testing.md) before they reached a live deploy.

## Prerequisites

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

## 1. Install dependencies

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

## 2. Verify the code parses

```bash
npm run check        # syntax-checks every service and package .js file
npm run build:web     # builds the React dashboard; also type-shakes the JSX side
```

Both should finish clean. This is the fastest possible signal before you
spend time on infrastructure — see `infra/scripts/check-syntax.mjs` for
exactly what it does and doesn't cover.

## 3. Start local infrastructure

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

## 4. Configure environment variables

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

## 5. Start every service, in this order, each in its own terminal

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
[`testing.md`](./testing.md) for why that tag being correct is itself a thing
worth checking). If any service instead logs a stack trace and exits, the
infrastructure isn't reachable yet — re-check step 3 and that `.env` is
loaded in _that_ terminal.

## 6. Start the dashboard

```bash
# terminal 8
VITE_API_PROXY=http://localhost:$GATEWAY_PORT npm run dev:web
```

Open the URL Vite prints (typically `http://localhost:5173`). You should see
the Story page load with an entrance animation. It'll say "attract mode" with
nothing playing yet — that's correct, there's no completed run to replay.

## 7. Run something

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

### Seeing the oracle's bet

Start `oracle` (step 5, terminal 5) before starting a run, then watch the
"The oracle's bet" panel in the Console — it only shows something once the
twin has enough ticks to forecast from, so give a run at least 15–20 seconds.
Full detail on how it works: [`features.md`](./features.md#the-oracles-bet).

### Seeing the autoscaler report card

Just let a run finish (or stop it manually) — the "Autoscaler report card"
panel appears in the Console the moment `status` flips to `completed`, and a
grade badge appears next to that run in "Run history". No extra service or
flag needed; it's computed in `gateway`'s existing finalisation step. Some of
its six metrics (settling time, overshoot, cost efficiency) read the
ClickHouse `run_timeline` view, so if some of them come back `null`, check
that the `metrics` container was healthy in `docker compose ps` at the time
the run finished.

Runs completed *before* this feature shipped, or before ClickHouse was up,
have no scorecard. Backfill them:

```bash
npm run recompute-scorecards            # only runs with scorecard IS NULL
npm run recompute-scorecards -- --force # recompute every completed run
```

This is the same `computeScorecard()` the gateway calls live, run once over
each run's durable event log — see `infra/scripts/recompute-scorecards.mjs`
and [`features.md`](./features.md#the-autoscaler-report-card) for the full
metric reference.

### Seeing the golden run

Open the Story page (`#/`) with no backend running at all — the "attract
mode" panel falls back to "golden run — replaying ..." within a few seconds
and plays a committed fixture entirely client-side, no gateway/NATS/Postgres/
ClickHouse involved. This is what a judge sees if the backend is cold; it's
worth checking it actually works before you need it to. To refresh the
fixture with your own best run once you have a completed one locally:

```bash
npm run export-golden-run -- <runId>
```

Writes `apps/web/public/golden-run.json` — commit it by hand. See
[`features.md`](./features.md#the-golden-run) for the full design and why
it's a client-side fallback rather than a gateway route.

## 8. Tear down

```bash
docker compose down -v     # -v also drops the data volumes, for a clean slate next time
```

Ctrl-C each of the eight `npm run start:*` / `dev:web` terminals.

---

## Tuning autoscaling

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

## Environment variables reference

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
