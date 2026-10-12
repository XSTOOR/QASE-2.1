# Phase 5 · States, errors, and test coverage

## Goal
Cover all UI/Backend states with actionable messages and add the focused automated tests required by the brief, using mocked providers per the repo's fixture/fake conventions (no live LLM calls in `node:test`).

## States to handle (founderView + app.js)
Missing project context · generation in progress · successful recommendations · no sufficiently supported recommendations (distinct empty state, not an error) · model/provider failure · invalid structured output (validation failure surfaced as actionable retry) · persistence failure · handoff pending/success/failure · reopening a saved session. User inputs and last valid result are preserved on any failure.

## Tests to add/update (node:test, mocked providers)
- `server/founderService.test.js` / new `founderProjectState.test.js` — automatic context use; generation without advanced fields; optional goals/constraints applied; persistence & reopen; failed regeneration keeps previous set; obsolete-selection clearing; project/user isolation (ownerUserId).
- `server/founderSchema.test.js` — structured-response validation: required fields, effort enum, no numeric promises, dedupe/contradiction, min-3 evidence-bound count.
- `server/founderHandoff.test.js` — payload contains only selected recommendations + full detail; duplicate-submit 409; failed handoff preserves selections; success stores reference; fallback path when integration disabled; fetchImpl injection per `drytisStudioClient.test.js` pattern.
- `server/founderUi.test.js` / pins — selection controls, disabled send, states copy.
- Quality validation: run the founder flow against two materially different products (mocked transcripts/fixtures committed as test fixtures) asserting product-specific, prioritized, actionable output.

## Checks
- `npm test` (full suite ~833 tests) and any build/type check (none for JS; run `node --check` on touched files or lint if present). Fix regressions caused by these changes only.

## Acceptance criteria
- [ ] Every listed state is reachable in the UI with a clear, actionable message and preserved inputs.
- [ ] All new tests pass with mocked providers; live integration is clearly separated (if any, a manual step documented — never in `npm test`).
- [ ] Full existing suite passes.
