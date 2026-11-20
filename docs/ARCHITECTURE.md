# Architecture

QASE is a Node.js (22/24) Express application that tests live websites in a
real Playwright browser and serves a single-page dashboard written as plain
ES modules (no build step). There are three testing modes:

| Mode | What it produces | Engine |
| --- | --- | --- |
| **QA** | Defects with evidence and a fix prompt each; verdict pass / pass_with_issues / partial / fail / blocked | `server/qa/` — host-orchestrated detectors + reasoning model + JEV; talks in the run conversation and asks for a test account when needed ([QA-ENGINE.md](QA-ENGINE.md)) |
| **SQA** | Compliance test: product profile, researched standards with sources, every requirement tested, score and verdict per standard | `server/sqa/` — host-run stages with one CleanSlate SDK agent on the reasoning model only; talks in the run conversation ([sqa.md](sqa.md)) |
| **Founder** | Product and go-to-market review with evidence-bound recommendations | CleanSlate SDK agent loop with Founder tools ([founder-mode.md](founder-mode.md)) |

## Request path

```
browser ──HTTP/SSE──▶ server/app.js ──▶ services (serviceFactory.js)
                         │                 ├─ runs      local JSON store  | PostgreSQL (+ Redis events)
                         │                 ├─ agent     runTurn(): QA → server/qa/  ·  SQA → server/sqa/  ·  Founder → SDK loop
                         │                 ├─ secrets   per-run encrypted vault
                         │                 ├─ artifacts screenshots/evidence (.qase/artifacts or QASE_ARTIFACT_DIR)
                         │                 └─ auth, feedback, bugs, test cases, catalog, matrix …
                         └─ public/  static dashboard (index.html, app.js and view modules)
```

- `server/index.js` boots the API: configuration, storage adapter, browser
  registry probe, keepalive, boot-time run recovery (`runResume.js`) and
  graceful shutdown.
- `server/app.js` holds the HTTP routes. Every mutating route requires a
  session and CSRF token (`auth.js`); runs are scoped to their owner
  (`requestActor.js`, `tenancy.js`).
- Run progress is pushed to the dashboard over one SSE stream per run
  (`/api/sessions/:id/events`): messages, activities, plan items (`todos`),
  findings, report, status, usage and live browser frames.

## Execution topologies

- **Local** (default): one process runs API and browsers; runs persist to
  `.qase/sessions.json`. Used by the single-host Compose deployment.
- **Distributed** (`QASE_EXECUTION_MODE=distributed`): API replicas enqueue
  jobs in PostgreSQL; `server/worker.js` processes claim them with leases and
  heartbeats (`distributedExecution.js`, `postgres/executionQueue.js`).
  Credentials travel to workers as short-lived encrypted envelopes in Redis.
- **Global control plane** (`server/controlPlane/`): optional cell registry
  and placement for multi-cell deployments, fed by `cellHeartbeatController.js`.

See [OPERATIONS.md](OPERATIONS.md) and `docs/enterprise-migration/` for the
infrastructure design history.

## Storage

- Local: `server/store.js` (JSON, atomic writes, crash recovery).
- PostgreSQL: `server/postgres/` with forced row-level tenant isolation;
  migrations in `server/postgres/migrations/` (001–045), applied by
  `npm run db:migrate` — never at application start.
- QA engine state lives in `session.hybrid` (column `qa_runs.hybrid_qa`).
- Artifacts (screenshots, evidence) carry execution-level metadata
  (`artifactStore.js`) so simulated evidence is never presented as a real device.

## Browsers and devices

- Engines: Chromium, Firefox, WebKit (`browserEngines.js`); branded local
  browsers are probed at boot (`localBrowserRegistry.js`).
- Device/browser catalog and environments (`environmentCatalog.js`,
  `catalogApi.js`, `deviceProfiles.js`) drive the launcher and the
  multi-configuration matrix runs (`matrixOrchestrator.js`), each of which is
  an ordinary QA run per configuration.
- Founder browses through `browserBridge.js` (policy-gated SDK browser).
  The QA and SQA engines own their Playwright browser (`server/qa/browser.js`).
  All use the same `browserPolicy.js` for scope and private-network protection.

## Models

- QA: optional reasoner + JEV via `server/qa/models.js`.
- SQA: the reasoning model only (`server/sqa/agent.js`), with the SDK's
  built-in web search for research.
- Founder: the account's configured provider through the CleanSlate SDK,
  or (opt-in) the qualified "mode reasoning" runtime (`modeReasoningRuntime.js`,
  `hybridConfig.js`, `hybridModelRouter.js`, `hybridUsageTransport.js`) with
  exact usage accounting. The `hybrid*` file names are historical.
- Token usage is accumulated per model on `session.tokenUsage`
  (`usageCapture.js`).

## Integrations

- **Drytis**: signed, cell-local review API (`drytisIntegrationApi.js`), the
  server-only client in `integrations/drytis/`, and Studio handoff of
  Founder actions. Contracts: [drytis-integration.md](drytis-integration.md),
  [drytis-integration.openapi.yaml](drytis-integration.openapi.yaml),
  [drytis-studio-integration-architecture.md](drytis-studio-integration-architecture.md).
- **BrowserStack** (optional remote real devices): `browserstackProvider.js`,
  `deviceRuntime/`.
- **Telegram** notifications for feedback (`telegramNotifier.js`), SMTP for
  password reset ([smtp-password-reset-setup.md](smtp-password-reset-setup.md)).

## Dashboard (`public/`)

`index.html` loads `app.js`, which composes view modules: the QA launcher and
browser matrix (`qaConfigMatrix.js`, `matrixPicker.js`, `devicePicker.js`),
the QA results workspace (`qaEvidenceView.js`), SQA (`sqaComplianceView.js`), Founder
(`founder*.js`), bugs, test cases and analytics. `fixPromptBuilder.js` is
shared with the server for the fix-prompt download and PDF report. Pure view
logic has `*.test.js` unit tests run by `npm test`.
