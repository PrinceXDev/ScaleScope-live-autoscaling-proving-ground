# Deploying ScaleScope — fast path

Where this stands: the entire backend (gateway, collector, worker, target,
oracle, chaos, scheduler) has been built, syntax-checked, and **run end to end
locally** — a real run starts through the barrier, load fires, the container
count is measured, chaos injection lands, the oracle predicts, and the run
finalises correctly. The web console builds cleanly. Two real bugs were found
and fixed by that local run (see [`testing.md`](./testing.md)) that would
otherwise have broken every single run or corrupted the architecture panel —
this is not theoretical readiness, it's tested.

What's *not* yet done, honestly: the full scroll-scrubbed story page (Lenis +
ScrollTrigger scrubbing a recorded run as you scroll) is stubbed as a hero +
attract-mode replay instead — real, working, just not the full scrollytelling
version. The scheduler's suite progress isn't yet wired to a live progress bar
in the Lab view (suites run correctly, you'd currently check via
`GET /api/runs` rather than watching a bar fill). Nothing here blocks a live
demo.

## The fastest path to a public, working demo

**1. Import the project.**

```bash
zcli project project-import zerops-project-import.yaml
```
or paste that file into **Import a project** in the Zerops GUI. This creates
all twelve services with their scaling config, but none of them have code yet.

**2. Push code to five services first** — this alone gets you the full live
autoscaling demo:

```bash
zcli push --setup gateway
zcli push --setup collector
zcli push --setup worker
zcli push --setup target
zcli push --setup web
```

Run each from the repo root — `zerops.yaml` at the root has one `setup:` block
per service (see the comment at its top for why: this is an npm-workspaces
monorepo, and `npm ci` has to run at the root for the shared `packages/*` to
link correctly). `db`, `metrics`, `cache`, and `nats` need no code at all —
they're managed services, already running the moment the import finished.

**3. Set the web app's API URL.** After `gateway` gets a public URL (enable
subdomain access if you haven't), edit `apps/web/public/config.json`:

```json
{ "apiUrl": "https://gateway-scalescope-xxxx.prg1.zerops.app" }
```

and re-push `web`. This is a static-file edit, not a rebuild — see the comment
in `apps/web/index.html` for why it's done this way (the API's hostname isn't
known until after import, and rebuilding the whole bundle every time it
changes is exactly the kind of thing you don't want to be doing an hour before
judging).

**4. Verify.** Open the `web` service's public URL. Go to `#/console`, start a
short run (durationS 30–60, spike profile is the most watchable), and confirm
the container count moves. That's the whole demo.

**5. Add the rest whenever you're ready — zero risk to what's already live:**

```bash
zcli push --setup oracle
zcli push --setup chaos
zcli push --setup scheduler
```

Each is an independent consumer of the same NATS subjects; none of them being
absent breaks anything already running, and none of them being added requires
touching a service that's already live.

## Before you load-test: the two decisions to sanity-check

**cpuMode is `DEDICATED`, not `SHARED`,** on `target` in the import YAML. Zerops'
own scaling docs say the horizontal-trigger CPU thresholds
(`minFreeCpuPercent` and friends) apply to dedicated CPU only. This was a
literal bug in the *original* (v1) version of this project's import YAML —
worth knowing so you don't "fix" it back the wrong way if you're diffing
against an older draft.

**Runs are capped server-side** — `durationS` at 180s, `cooldownS` at 180s,
`maxConcurrency` at 200 (`packages/contracts/src/profiles.js`, `LIMITS`) — and
the gateway enforces an hourly run budget (`MAX_RUNS_PER_HOUR`, default 12,
env-configurable) plus a single-active-run lock, both in Valkey so they hold
even if `gateway` scales. A public start button on a credit-billed backend
needs a ceiling; this is where it lives.

## Environment variables that matter

Set at the project level in the import YAML already:
- `SHARED_CHAOS_SECRET` — generated once at import, injected into both
  `target` and `chaos`. If you ever rotate it, rotate it in both places.

Per-service, already wired in the import YAML:
- `gateway`: `NATS_URL`, `MAX_RUNS_PER_HOUR`
- `chaos`: `NATS_URL`, `CHAOS_SECRET`, `TARGET_ADMIN_URL`
- `scheduler`: `NATS_URL`, `GATEWAY_URL`, `SUITE_MAX_RUNS`, `SUITE_MAX_TOTAL_S`

Zerops injects `db_connectionString`, `metrics_hostname`,
`cache_connectionString` etc. automatically for the data-tier services — no
manual wiring needed there; `packages/stores/src/*.js` reads them directly.

## If something doesn't scale

1. Check `cpuMode` is `DEDICATED` on `target` (see above).
2. Watch the Zerops GUI's own container count for `target` next to the
   dashboard's — they should track each other within a few seconds.
3. Tune `rounds` (CPU cost per request, in the run form) until one container
   saturates at a request rate your worker fleet can actually produce —
   `worker` defaults to `minContainers: 2`, which is normally enough.
4. If it's never scaled past one container after real tuning, that's still a
   demo — frame it as "distributed load lab with live latency telemetry", the
   container count panel just reads 1. Losing twenty minutes tuning is fine;
   losing three hours is not.
