# Phase 3 — Unattended matrix runs: pre-authorization, propagation, cleanup

## Goal
Matrix QA runs execute unattended: already-resolved setup authorization is honored, no
terminal BLOCKED on already-answered questions, browsers closed after each item.

## Current state (recon)
- Child sessions inherit `securityAuthorization` at creation (`server/app.js:853-871`) but
  nothing consumes it; any `ask_question` pause (`agent.js:1001-1007`, prompt rules
  `prompt.js:203-236`: login creds, irreversible actions, destructive confirmation, origin
  boundaries) terminally BLOCKs the child (`matrixOrchestrator.js:289-297`).
- No auto-answer/pre-authorize mechanism in matrix mode (only founder-mode has one,
  `app.js:1969-1972`).
- Orchestrator has NO browser cleanup; `closeOtherBrowsers` at turn start suspends others;
  idle-close disabled by default (`QASE_BROWSER_IDLE_MS=0`).

## Changes
**server/agent.js / orchestrator contract**
- At child-session creation for matrix runs, derive a `questionPolicy` from the run's
  `securityAuthorization` (already sent by the launcher UI): authorized target origin,
  approved intrusive-scan scope, destructive-action policy (default: NEVER auto-approve
  destructive; those still BLOCK honestly with a clear reason — do not weaken security).
- `ask_question` handling: if the question matches an already-authorized class (same-origin
  target permission, security-scan continuation approved in setup, non-credential logistics),
  auto-answer per policy and continue (logged as `auto_answered`, visible in item evidence).
  Login/credential questions remain BLOCKED with reason "needs credentials — add them to
  the run setup". Never fabricate credentials.
- The Start QA dialog already collects authorization — surface what will be auto-answered
  ("Authorization captured — runs will not re-ask target permission") so the user knows.

**server/matrixOrchestrator.js**
- After each item reaches a terminal state: explicitly close the child session's browser
  (reuse `closeBrowser` suspend semantics) — no process leak per item. Guard against
  closing a browser a concurrent item still needs (respect `closeOtherBrowsers` contract).
- awaiting_input on genuinely-new questions: keep BLOCKED mapping (honest), but item
  carries the question text so the results board can show WHY.

## Acceptance criteria
- [ ] A matrix run against an authorized target completes without any terminal BLOCKED caused by a re-ask of the setup-time authorization
- [ ] A run that genuinely needs credentials blocks on those items only, with the question visible in the results board
- [ ] After a multi-item run, no orphan browser processes remain (ps count stable across items; documented check)
- [ ] Destructive-action confirmations are NEVER auto-approved
- [ ] Auto-answered items are visibly marked (evidence/annotation), not silently resumed

## Tests
- server/matrixOrchestrator.test.js: policy-consumed auto-answer path; credential question
  → BLOCKED with reason; destructive → BLOCKED.
- server/app.test.js: securityAuthorization propagation to questionPolicy.
- Process-cleanup test (may be a scripted verification rather than unit test — document in
  build report; see incident-pid-exhaustion-zombies.md for container caveats).

## Edge cases
- Question arrives mid-turn after partial auto-answers — policy applies uniformly.
- Two concurrent items same owner (Phase 4 raises concurrency) — cleanup must not close a
  live sibling's browser.
