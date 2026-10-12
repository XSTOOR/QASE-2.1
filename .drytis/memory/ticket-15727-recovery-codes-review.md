# Review round 2 — Ticket #15727 (+#15725/#15726) "Recovery-code password recovery"

**Verdict: PASS on all 5 fix items + all re-verified PASS areas.** One environmental blocker (not code): full-suite run impossible in this container — see below.

## Fixes verified
1. PASS — recoveryCodeStatus crash: `?? []`/`?.length ?? 0` guards at auth.js:423-424. Live: login as tester@qase.dev (no codes) → GET /api/auth/recovery-codes = 200 `{"total":0,"unused":0}`.
2. PASS — server/recoveryCodes.test.js exists (3 tests). Ran it: **3 pass / 0 fail**. Coverage: full lifecycle (gen requires password, 10 codes, regex format, hashes-only scan of raw store file, neutral unknown-email vs wrong-code, lowercase/dashless normalization, reuse rejected, 7-char password rejected without consuming authorization, session revoked, authorization single-use, new-password-not-in-store), regeneration invalidates prior codes + counter reset, 5-wrong lockout (valid code → 429, regen resets → recovers).
3. PASS (file deletion) / N/A (suite totals) — passwordReset.http.test.js gone (glob: no match). **Full `node --test server/*.test.js` could NOT complete for environmental reasons** (PID exhaustion, see postmortem). recoveryCodes 3/3 was the only suite runnable/ran this round. Relevant suites were 52/52 green in round 1; only deltas since are the 5 fixes above.
4. PASS — local lockout expiry: auth.js:432-434 requires attempts>=5 AND recoveryAttemptsAt + RECOVERY_LOCKOUT_MS(15min, line 22) > now; attemptsAt set on each wrong code (:440), reset on success (:448-449) and on regeneration (:413-414). PG: qase_auth_attempts 15-min expiry, deleted on success and regen (:644-645, :692).
5. PASS — docs/auth-architecture-2026-09-10.md gained "## Recovery codes" (lines 24-28). Every claim checked accurate: 10 codes, XXXX-XXXX-XXXX over 32-char unambiguous alphabet (line 132: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', log2(32^12)=60 bits ✓), SHA-256-only persistence, migration 039 RLS, regeneration invalidates, GET counts-only, neutral 400 oracle, atomic consumption (+ FOR UPDATE on PG), shared 10-min single-use authorization, 8–200 policy, session revocation, 5/15-min lockout, counter reset on regen, admin-contact policy.

## Re-verified PASS areas (unchanged by the fixes)
- Hashes-only; plaintext solely in POST /api/auth/recovery-codes response (app.js:507-513).
- Neutral oracle incl. normalizeRecoveryCode throwing identical AuthError (auth.js:141-145).
- Atomicity: local persist-inside-withLock + throw outside (:439-442, :455); PG deferred throw after commit (:686-687, :703).
- Throttle/CSRF: app.js:358 POST array, :314 pre-auth allowlist — intact.
- Regeneration: local full array replacement; PG superseded UPDATE + generation insert.
- Migration 039 unchanged: FORCE RLS, tenant policy, unique code_hash, hash-only columns.
- Frontend: only `resetAuthorization` (the reset token) in module scope; no recovery codes stored (grep app.js: recovery appears only as resetAuthorization assignments 6820/6911).

## Environmental blocker (IMPORTANT for next agents)
Running `node --test server/*.test.js` (≈150 suites, process-isolated) blew the container PID/task limit. My parallel retry (`xargs -P8`) left ~7,600 defunct children reparented to PID 1 which never reaps them (kill -CHLD 1 no effect). State at end of review: fork permanently fails (EAGAIN), node cannot even start (uv_thread_create assert). **Do NOT run the full test suite in this container; it needs an infra restart.** Single light suites may work after restart. Live app (service-bg-service-4182) survived and serves 200 on :5173 throughout.
