# Qase

An autonomous QA agent that tests live websites in a real browser, built on
[`@cleanslate/sdk`](https://www.npmjs.com/package/@cleanslate/sdk).

Paste a URL. Qase opens the site in Chromium, writes a test plan, works through
it, and files what breaks — while you watch the cursor move.

## Setup

```bash
npm install && npm run install-browser
```

Then start it:

```bash
npm start
```

Open http://127.0.0.1:5173. On first launch, create the single owner account,
then click **Settings** and fill in three fields:

| Field | What it is |
| --- | --- |
| API key | Your key |
| Base URL | The root your client appends `/chat/completions` to. Include `/v1` if your gateway expects it. |
| Model name | Exactly the id your endpoint expects |

Pick **custom** as the provider for any OpenAI-compatible endpoint. **Test
connection** probes it and loads the model list before you commit. Settings are
saved to `.qase/config.json`; `.env` works too, and the file wins over `.env`.

Nothing to test against yet? Outside production, the server hosts a deliberately
broken practice site at http://localhost:5173/demo — sign in with
`demo@qase.dev` / `demo1234`. Production mode always disables this route.

## The dashboard

**Left** — your runs. **Middle** — the conversation, with what the agent is
thinking pinned above the composer while it works. **Right** — the live browser
with the agent's cursor drawn over it, and tabs for Activity, Plan, Findings and
the Report.

The cursor and the highlight box are drawn over the video feed, not injected
into the page under test, so watching a run never changes what is being tested.

## Logging in

When the agent hits a login wall it stops and asks. Type the credentials into
the form that appears and they go into a server-side vault — **the model never
sees them**. It fills the form with `{{QA_USERNAME}}` and `{{QA_PASSWORD}}`, and
the real values are substituted at the keyboard. Anything that leaks back
through a page snapshot or an error is masked before it reaches the model or
the screen.

Credentials are held in memory only. They are never written to disk and are
gone when the server stops.

## Owner authentication

Qase creates one owner account per local instance. The password is stored only
as a salted `scrypt` hash in the current user's private OS app-data directory;
authenticated sessions use an
opaque `HttpOnly`, `SameSite=Strict` cookie and all dashboard APIs, reports and
event streams require that session. **Remember me** extends the server-side
session to 30 days; signing out revokes it immediately.

The server listens on `127.0.0.1` by default so an unconfigured first launch
cannot be claimed from another machine. For a public deployment, use HTTPS and
a trusted reverse proxy, set `QASE_AUTH_COOKIE_SECURE=true`, and configure a
one-time `QASE_AUTH_SETUP_TOKEN` before creating the owner. There are
intentionally no default credentials.

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
| `QASE_AUTH_SESSION_HOURS` | `12` | Lifetime of a normal authenticated session |
| `QASE_AUTH_MODE` | `local` | `local` owner login or PostgreSQL-backed `drytis` signed-launch SSO |
| `QASE_PUBLIC_URL` | — | Required HTTPS public origin in Drytis mode |
| `QASE_DRYTIS_LOGIN_URL` | — | Drytis launch-page URL used to begin SSO |
| `QASE_DRYTIS_ISSUER` | — | Exact trusted JWT issuer |
| `QASE_DRYTIS_AUDIENCE` | — | Exact Qase audience required in launch JWTs |
| `QASE_DRYTIS_JWKS_URL` | — | HTTPS Drytis signing-key endpoint with rotation support |
| `QASE_EXECUTION_MODE` | `local` | `distributed` moves agent/browser work into dedicated workers |
| `QASE_REDIS_URL` | — | Redis transport URL; production distributed mode requires `rediss://` |
| `QASE_SECRETS_MASTER_KEY` | — | Shared base64url 32-byte key for short-lived encrypted worker credentials |
| `QASE_WORKER_LEASE_MS` | `30000` | Durable worker lease duration; heartbeats run at one third of this value |
| `QASE_JOB_MAX_ATTEMPTS` | `3` | Maximum claims before a repeatedly abandoned job fails visibly |
| `QASE_JOB_RETENTION_DAYS` | `30` | Terminal job retention; cleanup is bounded to 1,000 rows per claim cycle |
| `QASE_QUEUE_MAX_ACTIVE_JOBS` | `5000` | Cell-wide cap on queued/leased/cancelling jobs across API replicas |
| `QASE_MUTATION_MAX_IN_FLIGHT` | `64` | Per-replica concurrent mutating-request guard |
| `QASE_METRICS_TOKEN` | unset | Enables bearer-protected `/metrics`; must contain at least 32 bytes |
| `QASE_WORKER_PROBE_HOST` | `127.0.0.1` | Worker liveness/readiness/metrics bind address |
| `QASE_WORKER_PROBE_PORT` | `9174` | Worker probe listener port; use `0` only for tests |
| `QASE_CONTROL_DATABASE_URL` | unset | Separate PostgreSQL database for global cell/placement metadata |
| `QASE_CONTROL_MIGRATION_DATABASE_URL` | unset | Separate DDL credential for `npm run control:db:migrate` |
| `QASE_CONTROL_API_READ_TOKEN` | unset | Internal Drytis resolver credential; at least 32 bytes |
| `QASE_CONTROL_API_WRITE_TOKEN` | unset | Distinct deployment-controller credential; at least 32 bytes |
| `QASE_CONTROL_CELL_STALE_SECONDS` | `90` | Heartbeat age after which placement resolution fails closed |
| `QASE_CONTROL_HOST` / `QASE_CONTROL_PORT` | `127.0.0.1` / `5180` | Internal control-plane listener |
| `QASE_CELL_ID` / `QASE_CELL_REGION` | unset | Stable identity used by the trusted cell heartbeat controller |
| `QASE_CELL_METRICS_URL` | unset | Private bearer-protected API metrics URL read by the controller |
| `QASE_CELL_HEARTBEAT_INTERVAL_MS` | `30000` | Cell observation publish interval with capped retry backoff |
| `QASE_AUTH_REMEMBER_DAYS` | `30` | Lifetime when **Remember me** is selected |
| `QASE_AUTH_COOKIE_SECURE` | `auto` | `true` forces HTTPS-only auth cookies; `auto` follows the incoming protocol |
| `QASE_AUTH_SETUP_TOKEN` | unset | Required for first-owner setup from a non-loopback address |
| `QASE_AUTH_FILE` | user app data | Optional private location for the owner hash and session digests |
| `QASE_TRUST_PROXY` | `false` | Trust exactly one reverse proxy for HTTPS detection |
| `QASE_HEADLESS` | `true` | `false` also opens a visible browser window |
| `QASE_CURSOR_DWELL_MS` | `420` | How long the cursor is shown travelling to its target. Deliberate latency, so a run is watchable. `0` disables it. |
| `QASE_NAV_SETTLE_MS` | `1600` | How long a click waits for a client-side router before the URL is reported |
| `QASE_FRAME_INTERVAL_MS` | `320` | Live view frame interval |
| `QASE_FRAME_QUALITY` | `55` | Live view JPEG quality |
| `QASE_BROWSER_IDLE_MS` | `0` | Close a session's browser after this long idle. `0` keeps it open for the whole session. Cookies and the current page are restored either way. |
| `QASE_MAX_TURNS` | `120` | Hard ceiling on agent turns per run |

## Sharing it

`npm run package` writes `qase-share.zip` — the source only, without
`node_modules`, your API key, or your run history. Send that.

Do **not** zip the folder as it stands: `.env` and `.qase/config.json` contain
your API key, and `.qase/sessions.json` contains everything you have tested.
The owner hash and active session digests live separately in the current
user's private app-data directory (or `QASE_AUTH_FILE` when overridden).

Whoever receives it runs `npm install && npm run install-browser`, then
`npm start`, and enters their own endpoint under Settings.

For the production process/container topology, deployment order, safe smoke and
load probes, failure drills, and recovery contract, see
`docs/enterprise-migration/phase-7-deployment-resilience.md` and
`deploy/kubernetes/README.md`.

## How it works

`@cleanslate/sdk` supplies the agent loop, the tool protocol and a Playwright
browser. This app adds four things around it:

- **A tool gate** (`server/agent.js`) that narrows 59 tools down to browser
  automation plus two of its own — `report_finding` and `finish_qa_report`.
- **A browser bridge** (`server/browserBridge.js`) that publishes where each
  action is about to land before performing it, so the run can be watched, and
  waits for client-side navigation to settle before reporting a URL.
- **A credential vault** (`server/secrets.js`) that keeps secrets out of the
  model's context entirely.
- **The dashboard** (`public/`), which renders one SSE stream.
