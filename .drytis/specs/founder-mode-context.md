# Phase 1 · Project context reuse & simple default flow

## Goal
When Founder Mode is launched, automatically use the current trusted project context (target URL, Studio project metadata, previous QA findings, saved founder context) instead of asking the founder to re-enter it. Make advanced fields optional.

## Files to change
- `server/founderService.js` — resolve project context at session creation (from trusted server-side sources only).
- `server/founderPrompt.js` — `buildFounderContext` gains: previous findings summary, Studio projectContext metadata, prior founder session context. Distinguish observed facts / user-provided / assumptions sections.
- `server/app.js` — `POST /api/founder/sessions` accepts optional goal/constraints; new `GET /api/founder/context` returning detected context (target URL candidates, project metadata availability, findings count, last founder state) for the launch dialog.
- `server/store.js` / `server/postgres/runRepository.js` — query helpers: latest Drytis `projectContext` for the project, aggregated findings summary.
- `public/app.js` (founderUi launcher) — prefill target URL from detected context; move primary-goal + constraints fields into a collapsed "Advanced options" section; missing-context state when no URL can be detected.
- `public/index.html` — dialog restructure.
- `server/founderUi.test.js` — update source pins.

## Rules
- Tenant/project identity comes only from the trusted `tenancy.js` context — never from request bodies (existing rule).
- Never fabricate product capabilities, customers, revenue, market data. If context is thin, prompt must instruct the model to mark items as assumptions and generate fewer recommendations.
- Generation must work with zero advanced fields.
- Keep the existing launch contract backward compatible (`authorizationConfirmed` gate unchanged).

## Acceptance criteria
- [ ] Launching Founder Mode prefills the detected target URL; user can still override before authorization.
- [ ] A clear missing-context state appears when no target URL/metadata is available, asking only for the missing piece.
- [ ] The founder prompt includes previous QA findings and Studio project metadata when they exist, labeled as observed facts vs assumptions.
- [ ] Recommendations generate with all advanced fields empty.
- [ ] No secrets/env contents enter model context (existing `secrets.js` redaction covers new inputs).
