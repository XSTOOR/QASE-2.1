# Review — Founder Mode Phase 4 (Studio handoff), ticket series following #15144

**Re-review (after fixes): 6 PASS / 0 FAIL / 2 minor WARN.** Suite 848/828 pass/0 fail/20 skip. All three original findings fixed and verified:

## Fixed findings (re-review evidence)
1. **Field coverage (was FAIL)** — `founderHandoff.js`: `label()` cap now 4,000 default (title 500, feature/why/outcome 2,000, priorityReason 1,000) matching schema bounds exactly (`founderSchema.js:233-245`); `scopeText()` accepts schema STRING implementationScope (≤4,000) with legacy-array tolerance; `evidence` reads `evidenceObservationIds` (schema) with legacy fallbacks. Unit fixtures schema-accurate; test 'long text fields are NOT truncated to 100 chars' pins 400/3,000-char survival.
2. **Dead founder target (was WARN)** — `drytisIntegrationFactory.js:48,65` reads `QASE_DRYTIS_FOUNDER_HANDOFF_PATH` (explicit opt-in, nulled when no deliveryClient); `index.js:108` passes `founderHandoffTarget` through. Signed-delivery path now reachable in production when env is set (still unset on this instance → export-only, by design).
3. **Pending never expires (was WARN)** — `PENDING_MAX_AGE_MS = 10 min` + `isStalePending()` (unparseable requestedAt → stale); fresh pending still 409s (test), 29-day-stale pending proceeds to deliver (test 'stale pending expires').

## Re-review residual notes (minor)
- API-level test fixture (`founderHandoffApi.test.js:21-24`) still uses legacy snake_case shapes (`implementation_scope: ['s']`, `evidence: ['e']`) — exercises legacy fallbacks; schema-accurate shapes covered only at unit level. Cosmetic coverage note.
- Stale-pending recovery re-delivers with a *new* idempotency key basis if selection differs (key = sorted ids + setVersion) — a crashed-but-actually-delivered handoff could theoretically double-deliver. Inherent to at-least-once delivery; acceptable.
- `scrubSecrets` still doesn't recurse into arrays of objects (unchanged, low risk).

## Still open from earlier phases (unchanged)
- Phase 2 `upgradeLegacyReport` dead code; Phase 3 selection-clearing on regeneration + misleading owner-enforcement comment in app.js (`/api/founder/state` GET/PATCH still lack owner/pilot gate — handoff route does have pilot 403).

## Original PASS findings that remain intact
Explicit-click-only send; 409 duplicate protection preserving selections; success only after backend receipt with reference ≤200; unavailable fallback never claims a build; 401 unauth (curl), CSRF via /api middleware, pilot 403 on handoff route, trusted-tenant projectId, secret scrub.
