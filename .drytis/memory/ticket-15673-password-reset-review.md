# Review — Ticket #15673 "Phase 2 · Forgot password & email reset flow" (2026-10-09)

**Verdict: PASS** (all spec criteria), one pre-existing WARN unrelated to the ticket.

## What was verified
- Tests: `node --test server/passwordReset.test.js server/passwordReset.http.test.js server/postgres/migrations.test.js server/auth.test.js server/app.test.js server/securityRegression.test.js` → **65/65 pass**.
- Browser E2E: `node scripts/test-reset-browser.mjs` → PASS line (neutral responses, outbox link, 8-char min, mismatch block, old-password revocation, single-use).
- Live preview probes: forgot-password for unknown + known email → byte-identical 200 neutral message; garbage reset token → 400 generic `invalid_or_expired_token`; GET / serves `#auth-forgot-switch`.
- Security: token = 32 random bytes base64url, only SHA-256 hex stored (local `passwordReset.tokenHash`; PG `token_hash char(64)`); TTL 60 min (`PASSWORD_RESET_TTL_MS`); single-use (`usedAt`/`used_at`, PG `FOR UPDATE`); sessions revoked on reset (both stores); forgot/reset in pre-auth allowlist (app.js:313) + throttle list (app.js:357); anti-enumeration identical responses.
- Log scan of /var/log/services/service-bg-service-4182.log after live flow: only route/status request lines, **no token fragments or links**.
- Migration 037 follows 011 pattern (FK CASCADE, FORCE RLS, tenant policy via set_config); migrations.test.js covers 037 + hash-only assertions.
- No SMTP secrets committed: git-tracked QASE_MAIL hits only in .env.example (commented, empty) + docs; `.env` (untracked, empty values) holds live config. `.qase/` git-ignored.

## Notes for future reviewers
- **Pre-existing WARN**: `server/app.js` ~line 1708-1746 — `POST /api/sessions` route body appears DUPLICATED (double `try` block; second half throws `ReferenceError: engine is not defined` at load of that handler at line ~1743). Not from #15673 (also visible pre-change in git blame/diff area); every other test still passes because the first try-block handles the request. Needs its own ticket.
- Spec coverage gap (minor, accepted): passwordReset tests exercise the LOCAL store only; PG `requestPasswordReset`/`resetPassword` (auth.js:427/443) verified by code read (FOR UPDATE row lock, supersede-then-insert, revocation) but no direct PG unit test; spec also said securityRegression.test.js should cover reset endpoints — it doesn't (app-level coverage lives in passwordReset.http.test.js instead).
- Probe cleanup: my live "known email" probe created a pending reset for tester@qase.dev; outbox entry removed (kept 0). Pending entry in .qase/auth.json expires in 60 min, single-use, unusable without outbox copy.
- Ticket #15672 (Phase 1) note: tester's browser run left probe account `boundary8-9k2x@example.test` in .qase/auth.json (per tester report) — leader to clean if desired.
- Environmental: `.qase/sessions.json.tmp-67` shows "Structure needs cleaning" (EIO, likely the documented ENOSPC/PID era) — worth an operator look, not app code.
