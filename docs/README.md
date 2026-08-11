# ScaleScope docs

Start with the root [`README.md`](../README.md) for the project pitch and a
five-minute orientation. Everything below is the detailed reference.

| Doc | Read this for |
| --- | --- |
| [`architecture.md`](./architecture.md) | The twelve services, how events flow between them, the repo layout, the live topology panel, and the two tricks that make Zerops-scaling observable without a privileged API |
| [`running-locally.md`](./running-locally.md) | Step-by-step: install, start local infra, start every service, run a load test, see the oracle's bet and the report card, tear down |
| [`deploy.md`](./deploy.md) | The fastest path from a fresh Zerops project to a public, working demo |
| [`testing.md`](./testing.md) | Exactly what has been run for real against live infrastructure, the bugs that run caught, and what's still only code-reviewed |
| [`features.md`](./features.md) | Deep reference for the oracle's bet and the autoscaler report card — formulas, thresholds, data contracts, and the reasoning behind them |

## Reading order

- **New to the project?** Root `README.md` → `architecture.md` →
  `running-locally.md`.
- **About to deploy?** `deploy.md`, then `testing.md` to know what's actually
  been verified versus code-reviewed.
- **Extending the oracle's bet or the report card?** `features.md` has the
  exact formulas, thresholds, and data shapes — read it before changing
  `packages/control/src/scorecard.js` or
  `apps/web/src/components/PredictionBet.jsx`, since both are documented in
  enough detail there to change safely without re-deriving the reasoning.
