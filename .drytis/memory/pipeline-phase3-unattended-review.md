# Phase 3 (#15493) unattended matrix runs — review 2026-10

Spec: .drytis/specs/pipeline-unattended-authorization.md. Working tree (uncommitted, on b68a549).

## Verdict: PASS with 3 WARNs

- Tests: matrixQuestionPolicy 6/6, matrixOrchestrator 18/18 (12 pre-existing unchanged — diff is append-only), app.test.js 36/36, matrixService+matrixApi+qaUiSelection 33/33.
- Security posture verified: credentials never auto-answered (credentialLike flag + isCredentialQuestion heuristic, checked BEFORE authorization class); destructive never auto-approved (DESTRUCTIVE_HINT regex incl. options labels, checked before authorization hint); policy requires securityAuthorization.confirmed === true, which only reaches the run record via validateSecurityAuthorization (server/appQaSelection.js:80-107) → matrixService create/createBatch → run.securityAuthorization → orchestrator loop. blockedReasonFor checks destructive FIRST (credential regex is broad — matches "account").
- resumeSession (app.js:887-894) reuses addMessage + startTurn({resumeAnswer}) — same machinery as interactive /answer route (app.js:2033-2043). MAX_AUTO_ANSWERS_PER_ITEM=3 anti-loop; resumeSession===false and timeout throw both break honestly.
- Cleanup: hoisted itemSession + finally → closeSessionBrowser → agent.closeBrowser(sessionId) (suspend semantics). Per-session only — cannot close a concurrent sibling's browser (AC edge case). Guarded try/catch so cleanup can't mask outcomes; null-session (NOT_SUPPORTED/early return) throws inside the async hook and is swallowed.

## WARNs (carried forward)
1. AC "question visible in results board": item.question IS persisted (sliced 2,000) and error text embeds it for uncovered-class questions, but public/qaMatrixResults.js toResultRow (line 76-109) does NOT map item.question or autoAnswers/autoAnswerEvidence — UI renders only row.error/row.reason. Credential-block reason is generic ("needs sign-in credentials") so the specific question is invisible in the board UI; auto-answer evidence likewise not surfaced.
2. Spec's "Tests" section asks for app.test.js coverage of securityAuthorization → questionPolicy propagation; existing app.test.js only covers securityAuthorization → session (lines 470-509). Policy consumption is covered at orchestrator level instead.
3. No documented ps-count/orphan-process verification (spec permits scripted check documented in build report; incident-pid-exhaustion-zombies.md context). Only unit-level closeSessionBrowser-call-count tests exist.

## Notes
- Spec said derive policy at child-session creation in agent.js; implementation derives it in the orchestrator loop per question — functionally equivalent, simpler (single consumer), acceptable deviation.
- app.js diff also contains Phase-2 batching (parent/batch create, per-batch 2,000 cap) and device-grouped catalog windows — separate phase, not reviewed here in depth.
- patterns.md does not exist.
