# JEV integration and JEV-only local QASE

JEV (TypeSafe Decisions, `jev-1.13`) is used in two ways:

- **QA mode** (any provider): the QA engine sends every candidate defect to
  JEV for verification and severity grading. See [QA-ENGINE.md](QA-ENGINE.md).
- **JEV-only instance** (`QASE_PROVIDER=jev`): QA runs use the QA engine with
  JEV verification. SQA (compliance testing) and Founder (business review)
  never use JEV; they use the reasoning model, and without one they report
  from measured evidence (see [sqa.md](sqa.md), [founder-mode.md](founder-mode.md)).

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

The JEV decision controller that once drove Founder mode on JEV-only
instances (`jevRuntime.js` and its browser samplers) was removed with the old
Founder pipeline. Founder is now a stage engine on the reasoning model.

## Verification

```sh
node --test server/qa/*.test.js   # includes the JEV verification of QA findings
```
