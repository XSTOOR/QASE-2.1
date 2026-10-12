# #14276 selection fix review (computeCappedSelection + store targeting)

Reviewed the uncommitted diff on NIHARIKA (public/qaConfigMatrix.js, public/app.js, public/qaConfigMatrix.test.js).

Verdict: PASS overall. 5 new regression tests; public suite 210/210, targeted server files (app, qaConfigurations, matrixService, matrixOrchestrator, browserBridge*, runtimeIdentity, deviceRuntimeProfiles) all green.

## Verified correct
- computeCappedSelection: deselections applied first (persisted opt-out beats explicit tick — confirmed by simulation), explicit ticks pinned before cap slice, no-explicit path identical to computeSelection().slice(0,2000).
- Version-chip handler writes deviceScopeSessionDeselections when scoped (was the silent no-op root cause #1), persisted store + unscopedExplicitSelection when unscoped (root cause #2).
- Explicit set cleared on scope change AND catalog-load error (app.js:5140, 4995). Session-only, never persisted → no localStorage growth.
- Start gating (syncQaSubmitState) and over-cap summary message consistent; 2,000 wording matches server 422 in server/app.js:978.

## WARNs (non-blocking)
1. Family re-tick unscoped adds ALL family rows (~8.6k for Chrome) to unscopedExplicitSelection → selection exceeds cap → Start disabled with "too many configurations selected" until narrowed. Honest and consistently gated, but new friction vs. old silent 2,000 slice. Pre-fix re-tick after untick also silently gave an all-Android 2,000 — different, not worse.
2. >2000 individual explicit ticks → over cap, same honest gate.
3. Cosmetic: family change-handler block re-indented (extra tab) → noisy diff.

## Full suite NOT verifiable in this container
Three full `node --test server/... postgres/... controlPlane/... public/...` attempts hit the documented PID-exhaustion (incident-pid-exhaustion-zombies.md); container restarted twice; one partial run showed 920 tests / 808 pass / 98 fail with EAGAIN spawn errors throughout (environmental). Do NOT re-run full suite here — targeted files only.

## Note
The tester's browser repro (first chip click swallowed in device scope) is exactly root cause #1; fix addresses it. Live browser retest after fix not yet performed by tester.
