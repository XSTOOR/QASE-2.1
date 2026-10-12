# Review: Founder Mode Phase 3 — project-level persistence (ticket #15144)

Spec: `.drytis/specs/founder-mode-persistence.md`. Suite: 829 tests, 809 pass, 0 fail, 20 skipped (baseline for this phase). Verdict: 4 PASS / 0 FAIL / 2 WARN.

## Key facts
- `founder_project_state` table (migration 024): PK (organization_id, project_id), state jsonb, CHECK ≤1MB + schemaVersion ≤1. Local mirror: `.qase/founder-project-state.json` via store.js; both behind `getFounderProjectState`/`saveFounderProjectState` runStore methods.
- Persistence write path is ONLY the `subscribeGlobal('founder.finalized')` hook in app.js (~line 164) → `projectStateFromSession` → save; failures logged, never break the run. Failed regeneration never emits the event, so prior state survives (proven by founderProjectState.test.js).
- `reconcileSelections` applied on read (GET /api/founder/state) and on write (PATCH /api/founder/state/selections). PATCH: 409 without saved set, 400 unknown ids, ≤50 ids ×128 chars, CSRF via generic /api middleware (verified 401 unauth).

## Open WARNs (follow-ups, not fixed)
1. **Selections cleared wholesale on regeneration**: `projectStateFromSession` builds state without `selections`, so a successful finalize overwrites the record dropping ALL prior selections — even ids that survive into the new set. Spec letter said "keep only selections whose ids still exist". Needs a product decision (merge old selections against new set ids in the hook) or spec amendment.
2. **Per-user isolation not implemented despite comment claiming it**: app.js comment on GET /api/founder/state says "owner is enforced against the requesting user unless the state predates per-user ownership" — NO such check exists. No pilot-role block either. Any authenticated user (incl. pilot users) can read/overwrite the instance-shared founder state. Tenant-project boundary (tenancy.js env-based, request-supplied tenant keys rejected) is the real and sound isolation for single-tenant-per-instance; the misleading comment (or an actual owner/pilot gate) should be fixed cheaply.

## Notes for later phases
- `handoff` key normalized + column reserved, nothing writes it yet — Phase 4 scope.
- `ownerUserId` is stored inside the state record (audit trail) but never consulted by the endpoints.
- Phase 2 leftover still open: `upgradeLegacyReport` in founderSchema.js remains dead code (zero call sites) — legacy reports rely on defensive rendering.
- Seeded founder run in test env exports markdown with literal `undefined` strings in the evidence registry "Bound browser evidence" sub-entries (tester note from Phase 2 re-run, not investigated).
