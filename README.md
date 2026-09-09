# Qase

An autonomous QA agent that tests live websites through a policy-gated browser
automation runtime.

Paste a URL. Qase opens the site in Chromium, writes a test plan, works through
it, and files what breaks — while you watch the cursor move.

## Setup

Use an actively supported Node.js LTS release (22 or 24).

```bash
npm install && npm run install-browser
```

Then start it:

```bash
npm start
```

Open http://127.0.0.1:5173, select **Begin transmission**, then click
**Settings** and fill in three fields:

| Field | What it is |
| --- | --- |
| API key | Your key |
| Base URL | The root your client appends `/chat/completions` to. Include `/v1` if your gateway expects it. |
| Model name | Exactly the id your endpoint expects |

Pick **custom** as the provider for any OpenAI-compatible endpoint. **Test
connection** probes it and loads the model list before you commit. Settings are
saved to `.qase/config.json`; `.env` works too, and the file wins over `.env`.

The server needs outbound HTTPS access to the configured model gateway and
network access to the websites being tested. A server launched inside a
network-restricted sandbox can serve the dashboard while all agent requests
fail. If Settings reports `EACCES/EPERM`, restart the server from a terminal
with the required network permissions; changing the API key will not fix that
restriction. Missing Chromium is a separate issue: run `npm run install-browser`
under the same OS account that runs Qase.

Nothing to test against yet? Outside production, the server hosts a deliberately
broken practice site at http://localhost:5173/demo — sign in with
`demo@qase.dev` / `demo1234`. Production mode always disables this route.

## Repository map

- `public/` contains the landing page and browser workspace.
- `server/` contains the HTTP API, browser agent, storage adapters, and tests.
- `integrations/drytis/` is the server-only Drytis adapter and signing protocol.
- `docs/` contains the current SQA, Founder Mode, and Drytis contracts;
  `docs/enterprise-migration/` records historical infrastructure phases.
- `deploy/`, `load/`, and `scripts/` contain referenced operational tooling.

Generated dependencies, runtime state, logs, reports, and share archives are
ignored and are not part of the source tree.

## The dashboard

**Left** — your runs. **Middle** — the conversation, with what the agent is
thinking pinned above the composer while it works. **Right** — the live browser
with the agent's cursor drawn over it, and tabs for Activity, Plan, Findings and
the Report. The slim mode dock on the far right starts standard QA, SQA, and
Founder Mode without displacing the working panels; on narrower screens it
becomes a bottom dock.

The cursor and the highlight box are drawn over the video feed, not injected
into the page under test, so watching a run never changes what is being tested.

## SQA assessments

Choose **SQA assessment** to create a separately scoped software-quality run.
Qase resolves a versioned, standards-informed control set, drives the existing
browser automation runtime through non-destructive checks, binds observations to
run evidence, and computes the verdict in a deterministic evaluator outside the
model. Mandatory controls without sufficient evidence remain **blocked**; the
agent cannot turn missing documents or regulatory review into a pass.

SQA produces a technical assessment, not an ISO certification, regulatory
approval, legal opinion, or whole-product compliance attestation. The built-in
catalog contains independently authored control objectives based on public
framework descriptions. Licensed standards text is not embedded or sent to the
model. See [`docs/sqa.md`](docs/sqa.md) for profiles, evidence contracts, APIs,
security boundaries, and the customer-licensed control-pack boundary.

## Founder Mode

Choose **Founder** in the mode dock to start an evidence-informed product and
go-to-market review. Supply the authorized URL plus the product stage, business
model, target-customer hypothesis, current goal, constraints, and any named
alternatives you already know. Qase inventories the browser-accessible product,
walks a representative workflow, checks diagnostics and responsive behavior,
and records evidence-bound strengths, friction, opportunities, and risks.

The resulting founder brief includes product/UI/UX improvements, ICP and
positioning hypotheses, monetization and pricing tests, sales and marketing
motions, prioritized recommendations, quick wins, metrics and experiments, and
a 30/60/90-day roadmap. Observed facts stay separate from assumptions, and each
recommendation carries impact, effort, and confidence. Founder Mode cannot see
source code, private analytics, customers, revenue, or unrelated competitor
sites unless that context is explicitly supplied through an authorized future
workflow, so it never represents browser review as complete codebase or market
research. See [`docs/founder-mode.md`](docs/founder-mode.md) for the complete
contract and API.

## Drytis product integration

Qase includes a disabled-by-default, cell-local Drytis data plane for a toolbar
integration. A Drytis backend can submit one signed project review containing
an authorized HTTPS preview for black-box testing, a bounded source snapshot
for deterministic white-box analysis, or both. Qase correlates both results
under one run and returns sanitized findings, coverage, a deep link, and repair
prompts that Drytis must treat as untrusted user-level input.

Every integration route authenticates the exact raw request target and body,
uses replay protection and durable business idempotency, and binds the request
to the cell's configured project. Submitted source is validated, analyzed only
in memory, never executed, and never persisted. PostgreSQL stores only bounded
derived analysis, source digests, findings, and correlation metadata. Drytis
can poll the canonical result or request a signed delivery to one fixed,
deployment-configured endpoint; request bodies cannot choose callback URLs.

This repository contains the Qase side, a versioned protocol, and a server-only
Drytis adapter at [`integrations/drytis/qaseClient.js`](integrations/drytis/qaseClient.js).
The actual toolbar button, per-user instance provisioning, snapshot packager,
result receiver, and human-approved patch workflow still belong in the Drytis
codebase. See
[`docs/drytis-studio-integration-architecture.md`](docs/drytis-studio-integration-architecture.md),
[`docs/drytis-integration.md`](docs/drytis-integration.md), and
[`docs/drytis-integration.openapi.yaml`](docs/drytis-integration.openapi.yaml)
for the payloads, signing algorithm, data flow, deployment controls, and current
production boundaries.

## Testing sites that require login

When the agent hits a login wall it stops and asks. Type the credentials into
the form that appears and they go into a server-side vault — **the model never
sees them**. It fills the form with `{{QA_USERNAME}}` and `{{QA_PASSWORD}}`, and
the real values are substituted at the keyboard. Anything that leaks back
through a page snapshot or an error is masked before it reaches the model or
the screen.

Local-mode credentials are held in memory only. Distributed workers receive a
short-lived AES-256-GCM encrypted envelope through Redis so another process can
perform the run; values are never written to PostgreSQL or the local workspace.
Qase clears the envelope on completion or deletion, and its bounded TTL is a
backstop for interrupted cleanup.

## First-party accounts and Drytis embedding

Qase now exposes a first-party account gate. Registration and login create a
server-side session with an opaque, hashed token; every account has its own
profile, memory entries, and run history. Authenticated writes require the
paired CSRF token. See [`docs/auth-architecture-2026-09-10.md`](docs/auth-architecture-2026-09-10.md)
for the API contract and PostgreSQL migration.

Drytis can still authenticate users upstream and frame a private Qase instance.
Set `QASE_AUTH_REQUIRED=false` only for that explicitly trusted compatibility
host. Keep a local instance on the default `127.0.0.1` listener. A Drytis
deployment must prevent direct public access at its gateway, provision an
isolated instance identity, isolate its runtime storage, and set
`QASE_DRYTIS_EMBED_ORIGIN` to the one Studio origin allowed to frame it.
Different users must not share a local `.qase` directory or the same
project-scoped database binding when their data must be isolated.
Qase rejects cross-origin API requests and emits restrictive browser security
headers in both modes.

`GET /healthz` is a public process-liveness probe. `GET /readyz` is a public
readiness probe for the configured storage adapter. Neither endpoint exposes
configuration or tests the model provider.

## What the agent may do

It has browser automation and nothing else — no filesystem, no shell, no
network tools. The permission gate refuses everything outside that list
regardless of what the model asks for.

It is told to test, not to damage: no deleting data, no changing account
settings, no sending messages, no completing a purchase. Where a flow can only
be tested by doing something irreversible, it stops and asks you instead.

You are pointing an autonomous agent at a real website. Point it at sites you
own or are authorised to test.

## Configuration

Everything below has a sensible default; set them in `.env` only if you need to.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `5173` | Server port |
| `QASE_HOST` | `127.0.0.1` | Interface to bind. Keep loopback unless you deliberately deploy Qase. |
| `QASE_ENABLE_DEMO` | `true` outside production | `false` disables the practice site; production always disables it |
| `QASE_DRYTIS_INTEGRATION_ENABLED` | `false` | Enables the signed cell-local Drytis review API; production requires PostgreSQL |
| `QASE_PUBLIC_URL` | — | Exact Qase origin used to produce an absolute Drytis `launchUrl` |
| `QASE_DRYTIS_API_ORIGIN` | — | Exact trusted Drytis service origin for the data plane |
| `QASE_DRYTIS_ALLOWED_ORIGINS` | — | Comma-separated exact HTTPS origins allowed for Qase-to-Drytis delivery |
| `QASE_DRYTIS_HMAC_KEY` | — | Shared 32-byte integration key encoded as unpadded base64url; store it as a secret |
| `QASE_DRYTIS_MAX_CLOCK_SKEW_SECONDS` | `300` | Signed-request timestamp window, bounded from 30 to 900 seconds |
| `QASE_DRYTIS_TIMEOUT_MS` | `10000` | Fixed outbound Drytis delivery timeout, capped at 30 seconds |
| `QASE_DRYTIS_MAX_REQUEST_BYTES` | `16777216` | Maximum signed body; source validation applies stricter limits |
| `QASE_DRYTIS_MAX_RESPONSE_BYTES` | `1048576` | Maximum accepted Drytis delivery receipt body |
| `QASE_DRYTIS_RESULTS_PATH` | unset | Optional fixed allowlisted delivery path or URL; never request supplied |
| `QASE_DRYTIS_EMBED_ORIGIN` | unset | One exact HTTPS Drytis origin allowed to frame Qase; otherwise framing stays denied |
| `QASE_EXECUTION_MODE` | `local` | `distributed` moves agent/browser work into dedicated workers |
| `QASE_REDIS_URL` | — | Redis transport URL; production distributed mode requires `rediss://` |
| `QASE_SECRETS_MASTER_KEY` | — | Shared base64url 32-byte key for short-lived encrypted worker credentials |
| `QASE_WORKER_LEASE_MS` | `30000` | Durable worker lease duration; heartbeats run at one third of this value |
| `QASE_JOB_MAX_ATTEMPTS` | `3` | Maximum claims before a repeatedly abandoned job fails visibly |
| `QASE_JOB_RETENTION_DAYS` | `30` | Terminal job retention; cleanup is bounded to 1,000 rows per claim cycle |
| `QASE_RUN_RETENTION_DAYS` | `30` | Grace after a PostgreSQL run tombstone before it can appear in a manual, legal-hold-aware purge preview |
| `QASE_GOVERNANCE_BATCH_SIZE` | `100` | Manual lifecycle command batch, hard-capped at 1,000 |
| `QASE_GOVERNANCE_ACK` | unset | Exact acknowledgement required together with `--apply` and an external change/case reference |
| `QASE_QUEUE_MAX_ACTIVE_JOBS` | `5000` | Cell-wide cap on queued/leased/cancelling jobs across API replicas |
| `QASE_MUTATION_MAX_IN_FLIGHT` | `64` | Per-replica concurrent mutating-request guard |
| `QASE_METRICS_TOKEN` | unset | Enables bearer-protected `/metrics`; must contain at least 32 bytes |
| `QASE_WORKER_PROBE_HOST` | `127.0.0.1` | Worker liveness/readiness/metrics bind address |
| `QASE_WORKER_PROBE_PORT` | `9174` | Worker probe listener port; use `0` only for tests |
| `QASE_LOG_FORMAT` / `QASE_LOG_LEVEL` | `json` / `info` in production | Correlation-safe stdout operational logs |
| `QASE_CONTROL_DATABASE_URL` | unset | Separate PostgreSQL database for global cell/placement metadata |
| `QASE_CONTROL_MIGRATION_DATABASE_URL` | unset | Separate DDL credential for `npm run control:db:migrate` |
| `QASE_CONTROL_API_READ_TOKEN` | unset | Internal Drytis resolver credential; at least 32 bytes |
| `QASE_CONTROL_API_WRITE_TOKEN` | unset | Distinct deployment-controller credential; at least 32 bytes |
| `QASE_CONTROL_CELL_STALE_SECONDS` | `90` | Heartbeat age after which placement resolution fails closed |
| `QASE_CONTROL_HOST` / `QASE_CONTROL_PORT` | `127.0.0.1` / `5180` | Internal control-plane listener |
| `QASE_CELL_ID` / `QASE_CELL_REGION` | unset | Stable identity used by the trusted cell heartbeat controller |
| `QASE_BOOTSTRAP_ORGANIZATION_ID` / `QASE_BOOTSTRAP_PROJECT_ID` | unset | Trusted tenant binding required when a cell registers; a cell cannot later be rebound to another tenant |
| `QASE_CELL_METRICS_URL` | unset | Private bearer-protected API metrics URL read by the controller |
| `QASE_CELL_HEARTBEAT_INTERVAL_MS` | `30000` | Cell observation publish interval with capped retry backoff |
| `QASE_TRUST_PROXY` | `false` | Trust exactly one reverse proxy for HTTPS detection |
| `QASE_HEADLESS` | `true` | `false` also opens a visible browser window |
| `QASE_CURSOR_DWELL_MS` | `420` | How long the cursor is shown travelling to its target. Deliberate latency, so a run is watchable. `0` disables it. |
| `QASE_NAV_SETTLE_MS` | `1600` | How long a click waits for a client-side router before the URL is reported |
| `QASE_FRAME_INTERVAL_MS` | `320` | Live view frame interval |
| `QASE_FRAME_QUALITY` | `55` | Live view JPEG quality |
| `QASE_BROWSER_IDLE_MS` | `0` | Close a session's browser after this long idle. `0` keeps it open for the whole session. Cookies and the current page are restored either way. |
| `QASE_BROWSER_ALLOWED_ORIGINS` | unset | Comma-separated trusted HTTP(S) origins (or `https://*.example.com`) that may receive top-level navigation outside the declared target origin |
| `QASE_BROWSER_ALLOWED_PRIVATE_HOSTS` | unset | Explicit private-network host exceptions for reviewed internal production targets; exact hosts or `*.example.com` only |
| `QASE_MAX_TURNS` | `120` | Hard ceiling on agent turns per run |

## Microphone and meeting checks

QA, SQA, and Founder agents can use `browser_media` to grant or deny microphone
permission, probe native browser capture, and inspect the application's actual
audio tracks. Chromium supplies synthetic input. The agent must also exercise
the app's start, mute/unmute, and stop controls, check permission denial and
recovery, and distinguish a successful probe from successful application use.
Muted MediaRecorder output can still grow while encoding silence.

`browser_test_meeting_link` opens one observed, visible meeting anchor in a tracked
tab. It supports same-origin meeting flows and narrowly scoped HTTPS Google Meet,
Zoom, Teams, and Webex entry routes. The agent inspects prejoin, authentication,
and expired-link states; opening a URL alone cannot establish a meeting pass.
Production network restrictions remain active. Joining live meetings requires
explicit authorization. Synthetic tests do not verify physical microphones,
remote participants, audio delivery, or speech recognition accuracy.

## Verification

```bash
npm ci --ignore-scripts
npm run install-browser
npm run verify
npm run test:browser
npm run test:dashboard
```

`verify` runs syntax, source credential-signature, ignore-rule, and automated
tests. `test:browser` runs real Chromium microphone, meeting, native form-validity,
and mobile restore checks against local fixtures. `test:dashboard` drives all
three launchers, stream reconnection, responsive dialogs, and available completed
fixture-report exports through the real HTTP application with a stub model.
Set `PLAYWRIGHT_BROWSERS_PATH` when Chromium uses a nondefault installation path.

Configured-model qualification is opt-in, sends generated fixture content to the
configured model gateway, and consumes model usage. It keeps its sessions separate
from saved user history and writes evidence under ignored `test-results/`:

```bash
npm run qualify:agent -- qa
npm run qualify:agent -- sqa
npm run qualify:agent -- founder
npm run qualify:agent -- qa --media-only
```

Use `QASE_QUALIFY_TIMEOUT_MS` to bound a run (default 15 minutes, maximum 30).
An unfinished controlled Founder qualification can resume report synthesis with
`npm run qualify:agent -- founder --resume test-results/<run>/session.json`.
Recovery reuses existing observations and is not a new browser qualification.
SQA recovery uses `npm run qualify:agent -- sqa --resume test-results/<run>/session.json`;
it restores this script's fixture at the original loopback port and completes
remaining checks using the saved evidence. The original port must be available.

The verification workflow provisions PostgreSQL and a restricted, non-superuser
test role for tenant-isolation tests. Locally, those integration tests skip unless
`QASE_TEST_DATABASE_URL` and `QASE_TEST_CONTROL_DATABASE_URL` point to suitable test
databases. CI itself and staging deployment qualification must pass before release.
See [the production-readiness report](docs/production-readiness-report-2026-09-10.md)
for measured results and remaining release requirements.

## Sharing it

`npm run package` writes `qase-share.zip` — the source only, without
`node_modules`, your API key, or your run history. Send that.

Do **not** zip the folder as it stands: `.env` and `.qase/config.json` contain
your API key, and `.qase/sessions.json` contains everything you have tested.

Whoever receives it runs `npm install && npm run install-browser`, then
`npm start`, and enters their own endpoint under Settings.

For the production process/container topology, deployment order, safe smoke and
load probes, failure drills, and recovery contract, see
`docs/enterprise-migration/phase-7-deployment-resilience.md` and
`deploy/kubernetes/README.md`.

For Prometheus/Grafana wiring, SLO burn alerts, structured-log policy and the
read-only release gate, see
`docs/enterprise-migration/phase-8-observability-release.md` and
`deploy/observability/README.md`.

Capacity cannot be inferred from code or registered-user count. The staging-only
workload, strict evidence evaluator, resilience schema and qualification method
are documented in `docs/enterprise-migration/phase-9-capacity-qualification.md`
and `load/README.md`.

PostgreSQL run deletion is now a reversible tombstone. Legal holds, bounded
dry-run/apply retention, expired-auth cleanup, restore suppression and the
operator approval boundary are documented in
`docs/enterprise-migration/phase-10-data-governance.md`. No production purge
scheduler is enabled; `npm run data:governance -- runs-preview` is read-only.

## How it works

The runtime supplies the agent loop, a structured tool protocol, and an isolated
Playwright browser. This app adds four things around it:

- **A tool gate** (`server/agent.js`) that exposes only browser automation,
  planning/questions, media/meeting checks, and the active mode's evidence and
  finalization tools. Shell and filesystem tools are absent from the registry.
- **A browser bridge** (`server/browserBridge.js`) that publishes where each
  action is about to land before performing it, enforces target/network scope,
  requires explicit confirmation for destructive actions, and waits for
  client-side navigation to settle before reporting a URL. Production browser
  contexts disable service-worker registration because service-worker traffic
  cannot be inspected by Playwright request routing.
- **A credential vault** (`server/secrets.js`) that keeps secrets out of the
  model's context entirely.
- **The dashboard** (`public/`), which renders one SSE stream.
