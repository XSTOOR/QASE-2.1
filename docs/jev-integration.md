# JEV integration and JEV-only local QASE

JEV (TypeSafe Decisions, `jev-1.13`) is used in two ways:

- **QA mode** (any provider): the QA engine sends every candidate defect to
  JEV for verification and severity grading. See [QA-ENGINE.md](QA-ENGINE.md).
- **JEV-only instance** (`QASE_PROVIDER=jev`): Founder runs on the JEV
  decision controller described below instead of a generative model. QA runs
  use the QA engine with JEV verification. SQA (compliance testing) never uses
  JEV; it needs the reasoning model.

The native JEV adapter uses `jev-1.13` at
`https://llm.drytis.ai/typesafe/api/alpha/decisions`. The gateway resolves the
alias to the dated TypeSafe JEV model and the returned model ID is recorded
with each decision. It never calls a chat endpoint, JEV Router, or another
model. Model weights cannot be fine-tuned through this Decisions interface.
The integration changes QASE's controller and its SDK execution boundary.

## Start

Configure the ignored local `.env` file with `JEV_API_KEY`, `QASE_PROVIDER=jev`,
`QASE_MODEL=jev-1.13`, `QASE_LOCK_MODEL=true`, and the exact endpoint above as
`QASE_BASE_URL`. Set `NODE_ENV=development`, `PORT=5174`,
`QASE_HOST=127.0.0.1`, `QASE_PUBLIC_URL=http://127.0.0.1:5174`,
`QASE_RUN_STORE=local`, `QASE_EXECUTION_MODE=local`, and `QASE_HEADLESS=true`.
Keep credentials out of source control.

From this application directory:

```sh
PATH="$PWD/.tooling/node-v24.22.1-darwin-arm64/bin:$PATH" npm run start:jev
```

QASE is served at <http://127.0.0.1:5174> and its development-only model lab at
<http://127.0.0.1:5175>. QASE keeps its normal authentication. Register or sign
in with your local QASE account. The lab is loopback-only and rejects
cross-origin requests; its key is never sent to the browser.

## Architecture and scope

`server/jevClient.js` implements the native typed Decisions protocol, validates
requested answer types, candidate membership, model identity, probabilities,
and token usage, bounds body sizes and timeouts, disables redirects, and
supports cancellation. It does not automatically retry billable requests.

`server/jevRuntime.js` replaces the SDK's generative run loop for the JEV
provider while retaining the existing approved tool executor, browser bridge,
session activity stream, credential redaction, and mode-specific finalizers.
No package files in `node_modules` are patched. A JEV-only instance lock keeps
saved user preferences from silently selecting another model. SDK auxiliary
generation fails explicitly; test-case auto-generation uses the existing
deterministic fallback from recorded run evidence.

The host constructs candidate actions from fresh DOM snapshots. JEV chooses
among observed same-origin links and a limited set of reversible disclosure
controls. Query URLs, known destructive/account/commerce actions, and external
destinations are excluded. Existing network policies still apply. The host
persists attempted actions before execution to avoid repeating them after a
restart. Each invocation reacquires browser evidence. Founder retains its
bounded six-action sampler (`QASE_JEV_MAX_ACTIONS`). QA does not use this controller. The default decision limit is forty per
invocation (`QASE_JEV_MAX_DECISIONS`); prior invocations do not consume a new
turn's entire budget. All limits have hard upper bounds.

Founder mode classifies all review lenses against sampled DOM and diagnostics.
Unobserved business facts remain unknown, and recommendations use explicit,
low-confidence evidence-collection templates. These are not free-form model
strategy generation, validated market claims, or a complete user-journey review.
Missing product context triggers the existing structured question flow.

This is a deliberate change in review capability: the Decisions API cannot
generate arbitrary text, tool arguments, new test scenarios, or a bespoke
strategy document. The UI and reports describe the bounded scope explicitly.

## Verification

```sh
node --test server/jev.test.js server/jevBrowserChecks.test.js server/jevAccessibility.test.js
```
