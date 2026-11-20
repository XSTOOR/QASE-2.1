# QASE

QASE tests live websites in a real browser and reports what is broken, with
evidence and a ready-to-paste fix prompt for every defect.

- **QA** — crawls the site and tests layout (overlap, clipping, overflow),
  menus/dialogs and their animations, forms, accessibility, console/network
  health, performance and non-destructive security; the reasoning model
  explores user journeys and reviews screenshots; JEV verifies every finding.
  Every run finishes with a report. → [docs/QA-ENGINE.md](docs/QA-ENGINE.md)
- **SQA** — compliance testing: identifies the kind of product, researches the
  standards and laws that apply to it, tests each requirement and reports per
  standard. Reasoning model only. → [docs/sqa.md](docs/sqa.md)
- **Founder** — business review: what to change, avoid and keep so the product wins users.
  → [docs/founder-mode.md](docs/founder-mode.md)

Point QASE only at sites you own or are authorized to test.

## Quick start

Node.js 22 or 24.

```bash
npm ci
npm run install-browser
npm start            # http://127.0.0.1:5173
```

Register an account, choose **New test**, enter a URL. To try it without a
target of your own, test `http://127.0.0.1:5173/demo/qa-lab/` — a practice
site with planted defects (available outside production).

Models are optional for QA. Set `QASE_API_KEY` (and/or `JEV_API_KEY`) in the
environment or `.env` to enable AI exploration, visual review and JEV
verification; without keys QA still runs every automated check. SQA uses the
reasoning model (without it, it reports from a labelled baseline and measured
evidence). Founder uses the same reasoning model (without it, it advises from the measured
business signals). See `.env.example`.

## Repository map

| Path | Contents |
| --- | --- |
| `server/qa/` | QA engine: pipeline, detectors, models, triage, report, QA Lab |
| `server/` | HTTP API (`app.js`), QA engine (`qa/`), SQA compliance engine (`sqa/`), Founder business-review engine (`founder/`), storage, auth, browser policy, integrations |
| `server/postgres/`, `server/controlPlane/` | PostgreSQL adapters and migrations; optional multi-cell control plane |
| `public/` | Dashboard (plain ES modules, no build step) |
| `integrations/drytis/` | Server-only Drytis client and signing protocol |
| `scripts/` | Verification, qualification, release and operator tools |
| `deploy/`, `load/` | Compose and Kubernetes deployment, observability, capacity tooling |
| `docs/` | Architecture, operations and mode contracts |

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — components, request path, storage, topologies
- [QA engine](docs/QA-ENGINE.md) — phases, detectors, models, triage, safety, configuration
- [Operations](docs/OPERATIONS.md) — local setup, verification, CI, release, deployment, scripts
- [Operations runbook](docs/operations-runbook.md) — incidents and recovery
- [SQA](docs/sqa.md) · [Founder Mode](docs/founder-mode.md) · [JEV](docs/jev-integration.md)
- [Authentication](docs/auth-architecture.md) · [SMTP password reset](docs/smtp-password-reset-setup.md)
- [Drytis integration](docs/drytis-integration.md) · [Studio architecture](docs/drytis-studio-integration-architecture.md)
- [Release notes](RELEASE_NOTES.md)

## Testing

```bash
npm run verify                 # syntax, credential and ignore checks + npm test
npm run qualify:qa-live        # QA engine with your real model keys (capped)
```

More suites are listed in [Operations → Verification](docs/OPERATIONS.md#verification).

## Sharing the source

`npm run package` writes `qase-share.zip` without `node_modules`, keys or run
history. Do not zip the working folder: `.env` and `.qase/` hold API keys and
every tested run.
