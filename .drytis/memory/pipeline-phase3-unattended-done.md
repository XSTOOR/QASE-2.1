# Pipeline Phase 3 (#15493 unattended matrix runs) — DONE 2026-10-08

Reviewer verdict: PASS. All suites green.

## Implemented
- NEW `server/matrixQuestionPolicy.js` (+ `matrixQuestionPolicy.test.js`, 6 tests):
  - `deriveQuestionPolicy(securityAuthorization, run)` — authorized ONLY when `{confirmed:true}`.
  - `autoAnswerFor(policy, question)` — checks CREDENTIAL first (credentialLike flag + public/questionPresentation.js heuristic, both question text and option labels), then DESTRUCTIVE (broadened regex incl. `send…message/email/invitation`, purchase/pay/checkout/cancel/subscription/invit\w+), only THEN authorization-class (`AUTHORIZATION_HINT` narrow: permission/may i/proceed/security scan/intrusive/isolated test environment). Returns `{answer, basis}` or null.
  - `blockedReasonFor` — destructive reason takes PRECEDENCE over credential (heuristic's `\baccount\b` would otherwise misclassify "delete the test account").
  - `MAX_AUTO_ANSWERS_PER_ITEM = 3` anti-loop bound.
- `server/matrixOrchestrator.js` executeItem:
  - `let itemSession` hoisted above try → `finally { hooks.closeSessionBrowser?.(itemSession) }` guarded — browser hygiene on every path incl. ERROR.
  - awaiting_input LOOP: policy-covered questions resume the SAME session via `hooks.resumeSession(session, autoAnswer)`; `mark({autoAnswers, autoAnswerEvidence})` recorded BEFORE resume (never silent); re-poll; uncovered or bound-exceeded or resume-refused → BLOCKED with `blockedReasonFor` + `question` (sliced 2000) on the item.
- `server/app.js` orchestrator wiring: `resumeSession` (guard `session.pendingQuestion`, `services.runs.addMessage(kind:'answer')` + `startTurn({resumeAnswer})` — exact same machinery as interactive POST /answer) and `closeSessionBrowser` (`services.agent.closeBrowser(id, services.runs)` — suspend semantics, conversation survives).
- `public/index.html` + `styles.css`: `.qa-security-auth-note` under the security checkbox — "runs will not re-ask target-permission or scan-continuation questions; credentials and destructive actions are never auto-approved".

## Tests (all green)
matrixQuestionPolicy 6/6; matrixOrchestrator 18/18 (12 pre-existing UNCHANGED, 6 new: auto-answer→PASSED w/ evidence, credential BLOCKED w/ question text, destructive BLOCKED, unauthorized blocks, cleanup ×1/item, cleanup-on-error); app 36/36; matrixService 21/21 (5 new Phase 2 parent/batch idempotency tests); matrixApi 8/8 (1 new HTTP parent/batch/idempotency test, ~200s wall time — keep last); qaUiSelection 4/4 (new scope-as-view source-assertion test); qaConfigMatrix 45/45 (new planBatches/batchKeyFor tests; NOTE: planBatches(37244) last batch is 1244 not 644 — 18×2000+1244).

## Reviewer WARNs → tracked follow-ups
1. Results board does not render item.question / autoAnswerEvidence (server persists them) → Phase 5 (#15500).
2. No app.test.js propagation test (covered at orchestrator level instead) — acceptable.
3. Real ps-count orphan-browser verification → Phase 6 E2E (TEST 2).

## Ticket IDs (board tool truncates at 100 Done)
Phase 3 unattended = #15493 (DONE). Phase 4 concurrency = #15496. Phase 5 results board = #15500. Phase 6 E2E = next id. Phases 1-2: implemented earlier this session; Phase 1 selection review PASS (qaMatrixScopeView.test.js 6 tests + qaUiSelection scope test close the gap).