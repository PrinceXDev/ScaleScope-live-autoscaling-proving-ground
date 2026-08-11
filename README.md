# ScaleScope

### 🟢 [**Live demo → web-2e58.prg1.zerops.app**](https://web-2e58.prg1.zerops.app)

A live autoscaling proving ground, built on and about Zerops. ScaleScope fires
controlled load at a service and shows Zerops autoscaling in real time —
container count, latency, and throughput streaming live, with every run
replayable afterwards, a digital twin predicting what happens next, and
unattended experiment suites that turn one run into a swept curve.

Two features worth knowing where to find, both live in the Console
(`#/console` or a replay `#/r/:runId`) — full detail in
[`docs/features.md`](./docs/features.md):

- **The oracle's bet** — the digital twin's forecast, staged as a committed
  claim rather than a ghost line nobody watches. The moment the twin predicts
  ahead, the console freezes it on screen ("in 15s: 4 containers"), counts
  down, then lands the real value on top of it and scores the hit. A running
  MAE and hit-rate (±1 container) makes the claim falsifiable across every
  run, not just a one-off trick.
- **The autoscaler report card** — every completed run is graded on six
  reproducible metrics (reaction time, settling time, overshoot, flap score,
  cost efficiency, recovery) computed the same way every time, rolled into a
  composite letter grade. It's a capability report, not a verdict — the
  method for each metric is shown right next to its number. Appears once a
  run finishes; also recomputable retroactively for every past run.

**Status:** the full backend is built and has been run end to end against real
infrastructure (see [`docs/testing.md`](./docs/testing.md)). The web console
is built and builds cleanly. See [`docs/deploy.md`](./docs/deploy.md) for the
fastest path to a live, public demo.

## Documentation

Start here, then see [`docs/`](./docs/) for everything else:

| Doc | Read this for |
| --- | --- |
| [`docs/architecture.md`](./docs/architecture.md) | The twelve services, event flow, repo layout, the live topology panel |
| [`docs/running-locally.md`](./docs/running-locally.md) | Full local setup and run-through, including both features above |
| [`docs/deploy.md`](./docs/deploy.md) | Fastest path to a public Zerops demo |
| [`docs/testing.md`](./docs/testing.md) | What's actually been verified against real infrastructure, versus code-reviewed |
| [`docs/features.md`](./docs/features.md) | Deep reference for the oracle's bet and the report card — formulas, thresholds, data contracts |

## Quick start

```bash
git clone <your-repo-url> scalescope
cd scalescope
npm install
npm run check && npm run build:web   # confirm everything parses
docker compose up -d                 # local NATS, Postgres, Valkey-compatible cache, ClickHouse
cp .env.example .env && set -a && source .env && set +a
```

Then start each service (`npm run start:gateway`, `start:collector`,
`start:worker`, `start:target`, and optionally `start:oracle`, `start:chaos`,
`start:scheduler`) and the dashboard (`npm run dev:web`) — see
[`docs/running-locally.md`](./docs/running-locally.md) for the full walkthrough,
including port/env details and how to trigger a first run.

## Credits

Runs are capped server-side (`durationS` ≤ 180s, `cooldownS` ≤ 180s) and the
gateway enforces an hourly run budget plus a single-active-run lock, both in
Valkey so they hold even if the gateway itself scales. See
`packages/contracts/src/profiles.js` (`LIMITS`) and
`packages/stores/src/valkey.js` (`CreditBudget`, `RunLocks`).
