# Founder setup - Phase 3, 7 November 2026

This phase builds on integration commit `9be05b2` in
`integration/founder-sqa-20261107`.

## User flow

- Choose public pages only (default) or public and signed-in product coverage.
  Public-only is saved before execution; authenticated surfaces remain excluded
  and the review does not need a late credential decision.
- Choose visible evidence with explicitly labeled assumptions (default), or
  supply product stage, business model, target customer and primary goal.
  Supplied context requires all four fields. Optional goals/constraints remain
  available for an assumption-led review.
- Select a device/browser and confirm testing permission. The launcher explains
  the next missing requirement beside the submit button. Server preflight checks
  the actual environment/engine before creating the new versioned scope.
- Signed-in review continues to the existing run-specific secure vault form.
  No model/browser turn starts until the account is stored with consent or the
  owner chooses Skip login. Pending setup survives reload; repeated questions
  and reconnect snapshots preserve unsent inputs only in the current DOM form.
- The server rejects competing setup answers, preserves the question after a
  vault failure, and sends only credential placeholders to the agent. Public-only
  scope and context source appear in the review and Markdown/PDF report content.

## Compatibility and execution capability

The HTTP setup contract is explicitly versioned (`setupVersion: 1`). Existing
unversioned clients and saved/in-progress sessions keep their previous contract;
they are not silently migrated. Scope and context decisions use existing Founder
JSON state and pending-question persistence, so no database migration is needed.

Authenticated review is unavailable in the opt-in qualified discovery runtime
and in the bounded JEV runtime. The catalog advertises this capability, the form
disables that choice, and the server independently rejects it before creating a
run or accepting credentials. The existing configured-provider path retains its
vault-based sign-in behavior. This phase does not qualify arbitrary external
authentication, SSO, MFA, realtime workflows or distributed recovery.

## Verification

Full regression verification passed: 2,357 tests, 2,324 passed, zero failed or
cancelled, and 33 optional skips. Syntax checks, private-path checks and the
source credential scan passed. The final setup-answer state check was also
covered by a subsequent 67-test API/readiness run with zero failures. The
focused Founder/API suite passed 145 contracts, and the focused unit/release
suite passed all 40 tests. These counts overlap; they are not additive.

Browser execution uses injected model services and a fixture vault, not a live
provider or a real external account. All five mode/setup acceptance groups
passed with zero page errors. The existing Founder completion browser passed
all 11 checks, and the dashboard secure-access/reconnect/navigation acceptance
passed. Desktop/mobile screenshots were inspected, including an assertion that
the readiness message remains inside the visible mobile viewport.

Local evidence:

- `test-results/integration/phase3-full-verification.log`
- `test-results/integration/phase3-final-api.log`
- `test-results/integration/phase3-browser.log`
- `test-results/integration/phase3-completion-browser.log`
- `test-results/integration/phase3-dashboard.log`
- `test-results/system-mode-ui/result.json` and Founder setup screenshots

The optional skips cover unavailable infrastructure/opt-in fixtures and Windows
permission differences. Linux/Node 22 CI, Docker execution and live provider/
external-account qualification remain in the release matrix. Release identity
is `qase-founder-sqa-2026-11-07-setup-r1`, UI `20261107-2`.

The browser checks cover supplied-context validation, explicit assumptions,
scope persistence, pre-start secure setup, consent, repeated-question input
preservation, reload, Skip login, invalid URLs, delayed device restoration and
desktop/mobile layout. API tests also cover vault failure/retry, concurrent
answers, unsupported execution modes, and no credential values in run state,
events or model instructions. Existing Founder completion and SQA regressions
remain part of verification.

The existing design language is retained: plain fieldsets and labeled controls,
the current theme tokens, keyboard focus, and persistent readiness feedback. No
new credential store or automatic production activation is introduced.

Phase 3 is complete locally. Next: Phase 4, report completion and live provider
qualification. Push-SQA promotion remains in the release phase.
