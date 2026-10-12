# Phase 3 · Project-level Founder Mode persistence

## Goal
Persist founder context, recommendation sets, selections and handoff status at the project level, restored when Founder Mode is reopened for the same project. Failed regeneration must not erase the last good set; successful regeneration must drop selections that reference obsolete recommendation ids.

## Design decision
Existing founder state lives per-run (`qa_runs.founder_assessment`). Add a **new project-level table** rather than overloading `drytis_integration` (whose CHECK restricts it to `run_mode='qa'`): `founder_project_state` keyed by the trusted tenant project, storing latest context, latest good recommendation set + version, selections, and handoff reference. Local (non-Postgres) mode gets an equivalent in `store.js` (`.qase/` file convention) behind the same repository interface.

## Files to change
- `server/postgres/migrations/024_founder_project_state.sql` — table: `(organization_id, project_id) PK`, `context jsonb`, `recommendation_set jsonb`, `set_version`, `selections jsonb`, `handoff jsonb`, `updated_at`, size CHECK.
- `server/postgres/runRepository.js` (+ local `server/store.js`) — `getFounderProjectState`, `saveFounderProjectState` with optimistic replace; reuse `trustedTenantContext` (no request-supplied tenant keys).
- `server/founderProjectState.js` (new service) — state transitions: on finalize, replace set + clear selections referencing removed ids; on regenerate failure, keep previous set; owner scoping via existing `ownerUserId`/role checks.
- `server/app.js` — endpoints: `GET /api/founder/state` (restore), used by launcher and founderView; finalize path writes project state.
- `public/founderView.js` / `app.js` — on open, restore saved state (context, recommendations, selections, handoff status) when the project's target matches.

## Acceptance criteria
- [ ] Reopening Founder Mode for the same project restores the last saved recommendation set, selections and handoff status.
- [ ] A failed regeneration leaves the previous set and selections intact.
- [ ] A successful regeneration keeps only selections whose recommendation ids still exist.
- [ ] State is isolated per user/organization/project using existing access-control checks (pilot blocked, ownerUserId enforced).
- [ ] `npm run db:migrate` applies cleanly; local mode works without Postgres.
