# Phase 4 · Select & send to Studio (adapter over existing contract)

## Goal
Let the founder select recommendations (individually / all / none) and explicitly send them to Studio via the existing signed Drytis delivery contract, with duplicate-submit protection, honest success/failure states, and a copy/export fallback.

## Design decision
Manoj owns the shared Studio integration. We do NOT touch the QA push route or `drytis_integration` semantics. We add a small adapter that reuses `deliveryClient` + HMAC signing (`server/drytisIntegrationFactory.js`, `integrations/drytis/qaseClient.js`) to deliver a founder-handoff payload. Handoff records live in `founder_project_state.handoff` (Phase 3 table), not in `qa_runs.drytis_integration`.

## Payload (server-constructed, validated)
- projectId (trusted tenant context), source: `"founder"`, recommendationSetId + setVersion
- selectedRecommendationIds (server re-validates against the saved set; unknown ids rejected)
- per selected item: full recommendation object (title, scope, acceptance criteria, dependencies, priority order)
- product context + constraints
- ordered implementationRequirements (priority order), dependencies, acceptance criteria roll-up
- No secrets, no env file contents.

## Files to change
- `server/founderHandoff.js` (new) — payload builder + send via adapter; pending lock (one in-flight per project): if `handoff.status === 'pending'`, reject with 409; on failure keep selections and set status `failed` with message; on backend-confirmed success store returned job/thread reference, status `succeeded`, sentAt.
- `server/app.js` — `POST /api/founder/handoff` (auth + CSRF via existing middleware).
- `public/founderView.js` — checkbox per recommendation, Select all / Clear selection, "Send to Studio" button (disabled when none selected or pending); pending/success/failure states; displayed job reference; when the integration is not configured (`QASE_DRYTIS_INTEGRATION_ENABLED` false or no founder handoff target), show clearly-labeled "Copy handoff payload / Download" fallback and never claim a build started.
- `server/founderUi.test.js` pins updated.

## Acceptance criteria
- [ ] Selection alone never triggers anything; send requires an explicit click and ≥1 selected item.
- [ ] Double-clicking send while pending is rejected; selections survive a failed handoff.
- [ ] Success state appears only after backend confirmation, and shows the returned job/thread reference.
- [ ] With the integration disabled, the copy/export fallback is offered and no "build started" claim is made.
- [ ] Payload contains full detail for each selected recommendation — enough for the receiving agent to implement without guessing.
