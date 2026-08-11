# The oracle's bet, and the autoscaler report card

Detailed reference for the two features summarized in `README.md`. Both are
projections of the same durable event log everything else in this project
reads from — neither introduces a second source of truth.

---

## The oracle's bet

**Where:** `apps/web/src/components/PredictionBet.jsx`, wired into
`apps/web/src/views/Console.jsx`. State lives in `apps/web/src/lib/store.js`
(`pendingBet`, `betHistory`, `betAccuracy`).

### What it does

The digital twin (`packages/control/src/twin.js`, run by the `oracle`
service) already forecasts the container count ~15 seconds ahead, once per
tick, and the console already draws it as a dashed line on the timeline
chart. Nobody reads a dashed line mid-demo. This feature stages the same
forecast as a committed, falsifiable claim instead:

1. An oracle `prediction` event (`{ t, horizonS, predicted, confidence }`)
   arrives over SSE. The console latches it as `pendingBet` — one bet live at
   a time — and starts a countdown to `t + horizonS`.
2. The UI freezes the claim on screen: "in 15s: 4 containers", with a
   progress bar counting down.
3. When the real tick at that timestamp arrives, the bet resolves: `actual =
   tick.containers`, `absError = |actual - predicted|`, `hit = absError <=
   1`.
4. The resolved bet moves into `betHistory` (newest first, capped at 50) and
   folds into a running `betAccuracy = { n, mae, hitRate }`, computed
   incrementally (Welford-style running mean, not a stored array sum) so it
   never needs to rescan history.

### Why ±1 and not exact match

A tolerance of exactly 0, i.e. requiring the twin to call the *precise*
container count, would grade the twin against noise (a single container's
worth of scheduling jitter is not a modeling failure). ±1 container is the
same order of magnitude as the twin's own reported `meanAbsErrorContainers`
in normal operation — see `apps/oracle/src/persistence.js`'s `AccuracyLog`,
whose `exactRate()` already uses a comparable `absError < 0.5` band for its
own internal accuracy tracking. This feature's `hit <= 1` is deliberately a
little looser than the oracle's internal "exact" band, because the frontend
is reporting a **product-level** claim ("was the on-screen call basically
right") not the oracle's own tighter self-assessment.

### Edge case: a new forecast lands on the tick a prior bet was due

The oracle re-predicts every tick, so a fresh `prediction` event can arrive
in the same tick a prior bet's `dueT` is reached. `pushPrediction` in
`store.js` checks for this and scores the outgoing bet against the
just-arrived tick's `containers` *before* replacing it with the new one —
otherwise that bet would be silently discarded unresolved, quietly deflating
the sample size `betAccuracy.n` without deflating anything else, which would
make the hit rate look better than the twin's actual record.

### Data contract

```js
// prediction SSE event / `EVENT.PREDICTION` payload (packages/contracts/src/events.js)
{ runId, t, horizonS, predicted, confidence }

// pendingBet (store.js)
{ t, dueT: t + horizonS, horizonS, predicted, confidence }

// resolved bet (store.js, betHistory[0] is newest)
{ ...pendingBet, actual, absError, hit }

// betAccuracy (store.js)
{ n, mae, hitRate }   // hitRate = fraction of resolved bets with hit === true
```

Nothing here is persisted server-side — it's derived entirely client-side
from events already flowing through the existing SSE pipe (`prediction` +
`tick`), consistent with the project's own stated philosophy in
`packages/contracts/src/events.js`: don't build a second copy of something
already derivable from the log.

---

## The autoscaler report card

**Where:** `packages/control/src/scorecard.js` (pure function, no I/O — same
style as its sibling `envelope.js`). Computed in
`apps/gateway/src/orchestrator.js`'s `finishRun()`, persisted to
`runs.scorecard jsonb` (`infra/migrations/postgres/002_scorecard.sql`),
exposed via the existing `GET /api/runs` / `GET /api/runs/:id` (added to
`RUN_COLUMNS` in `apps/gateway/src/routes/runs.js` — no new endpoint).
Displayed by `apps/web/src/components/ReportCard.jsx`.

### Framing: capability report, not verdict

Grading a platform ScaleScope doesn't own can read as criticism if the
method is invisible. Every metric row in the UI carries its plain-language
method right next to its number (`scorecard.methodology[key]`) for exactly
this reason — a grade with a visible method is a measurement; a grade with a
hidden one is an accusation. Never render `scorecard.grade` without also
rendering `scorecard.methodology`.

### The six metrics

| Metric | Function | Method | Good | Bad (0-score) |
| --- | --- | --- | --- | --- |
| Reaction time | `reactionTime()` | SLO breach → first `scaled` event with `to > from` at or after the breach | 2s | 30s |
| Settling time | `settlingTime()` | From a load step, first point where container count holds within ±1 of its eventual level for 5 consecutive seconds | 5s | 60s |
| Overshoot | `overshoot()` | Peak containers run ÷ peak containers the observed `rps` implied were needed (`ceil(rps / capacityPerContainer)`) | 1.0× | 3.0× |
| Flap score | `flapScore()` | Scale-*direction* reversals (not scale events) per minute of run duration | 0/min | 6/min |
| Cost efficiency | `costEfficiency()` | Container-seconds actually spent ÷ container-seconds the observed load implied were required | 1.0× | 2.5× |
| Recovery | `recoveryTime()` | Chaos injection → p95 back under the run's SLO, sustained 5 consecutive seconds | 3s | 45s |

Lower is better for every metric. Each is linearly mapped onto a 0–100
sub-score by `subScore(value, good, bad)`, clamped to `[0, 100]`. The
composite is the mean of whichever sub-scores are non-null — a run with no
chaos event simply has no `recoveryTimeS` and the composite is computed over
the remaining five, rather than penalizing a run for a condition that never
occurred.

### Grade bands

```
97+  A+     87-89 B+     77-79 C+     60-69 D
93-96 A     83-86 B      73-76 C      <60   F
90-92 A-    80-82 B-     70-72 C-
```

See `GRADE_BANDS` in `scorecard.js` for the exact cutoffs.

### Why these thresholds and not others

The `good`/`bad` bounds are calibrated against this project's own load
profiles (`packages/contracts/src/profiles.js` — spikes and ramps over
90–180 second runs, SLOs around 500ms) rather than derived from any external
autoscaling benchmark. They are a deliberate, documented starting point, not
a claim of universality — a longer-duration or slower-SLO profile would
reasonably want different `good`/`bad` bounds. If you retune them, the
composite/grade of every historical run changes retroactively the next time
`recompute-scorecards` runs, which is intended: one method, applied
uniformly, is the entire point.

### Inputs and graceful degradation

`computeScorecard({ folded, events, timeline, capacityPerContainer })`:

- **`folded`** — `foldRun()`'s projection of the event log: `config`,
  `scaleEvents[]`, `chaosEvents[]`, `sloBreachAt`/`sloRecoverAt`. Required.
- **`events`** — the raw ordered event log. `foldRun()` only keeps the
  *current* phase and the *first* SLO breach/recover pair, not every
  transition, so metrics that need the full sequence (reaction time) scan
  `events` directly rather than extending `foldRun()`'s consumers.
- **`timeline`** — optional per-second rows `{ t, containers, rps, p95 }`,
  normally ClickHouse's `run_timeline` view. Three metrics (settling time,
  overshoot, cost efficiency) need a continuous curve the event log alone
  doesn't carry; without `timeline` they report `null` rather than
  approximate from sparse scale events.
- **`capacityPerContainer`** — req/s one container can absorb, used to
  compute "containers actually needed" for overshoot and cost efficiency.
  This number is not published by the platform; it's the oracle twin's
  learned parameter for this target (`twin_params.params.capacityPerContainer`
  in Postgres, looked up by `hostnameFromUrl(targetUrl):rounds`, mirroring
  `apps/oracle/src/persistence.js`'s own key derivation). Falls back to
  `DEFAULT_CAPACITY_PER_CONTAINER` (20 req/s) if no twin has learned one yet
  for that target shape — e.g. a target's very first run.

A run missing `timeline` or a learned `capacityPerContainer` still gets a
grade — just one averaged over fewer metrics, which is why `subScores` in
the persisted object always shows exactly which metrics were available for
that grade, alongside `assumptions.capacityPerContainer` so a fallback value
is never silently indistinguishable from a learned one.

### Backfilling historical runs

`infra/scripts/recompute-scorecards.mjs` (`npm run recompute-scorecards`)
re-derives scorecards for every `completed` run by replaying its durable
JetStream event log through the same `computeScorecard()` the gateway calls
live — this works because the scorecard is a pure projection of already-
persisted data, not something accumulated only while a run happens.

```bash
npm run recompute-scorecards            # only rows where scorecard IS NULL
npm run recompute-scorecards -- --force # recompute every completed run
```

Requires the same infrastructure as the gateway (Postgres, JetStream);
ClickHouse is best-effort — if it's unreachable, timeline-dependent metrics
come back `null` for that pass rather than the script failing outright.

### Persisted shape

```js
// runs.scorecard (jsonb)
{
  v: 1,
  metrics: {
    reactionTimeS, settlingTimeS, overshootRatio,
    flapPerMinute, costEfficiencyRatio, recoveryTimeS,   // each number | null
  },
  subScores: { /* same keys, each 0-100 | null */ },
  composite: number | null,   // mean of non-null subScores
  grade: string | null,       // e.g. "B+", null if composite is null
  methodology: { /* same keys, each a plain-language sentence */ },
  assumptions: { capacityPerContainer: number },
}
```

`v: 1` exists so a future change to the metric set or scoring bounds can be
told apart from runs graded under the old method, without needing a
migration to add the field after the fact.
