# Recovery codes (#15725–#15727) — shipped 2026-10-09

Feature: single-use recovery-code password recovery (no email needed). Profile → Security generates 10 codes (XXXX-XXXX-XXXX, 32-char alphabet, sha256-only storage) after current-password check; login page "Recover with a recovery code" exchanges email+code for the SAME short-lived reset authorization the email-OTP flow issues → existing reset-password endpoint (8-char min, session revocation). Neutral 400 oracle; 5 wrong attempts → 15-min lockout (local: recoveryAttempts + recoveryAttemptsAt timestamp; PG: qase_auth_attempts). Migration 039 qase_auth_recovery_codes (hash-only, RLS). Routes: POST/GET /api/auth/recovery-codes (auth+CSRF), POST /api/auth/recover (pre-auth, throttled). UI: #recover-panel 5th auth card; showAuthCard :not() selector updated.

Verified: reviewer PASS round 2 (all 5 findings fixed), tester PASS 5/5 round 2, live API probe 15 checks, suites 70/70 auth-relevant. Full-tree run: 147 suites chunked, all green except 3 that were environmental (see below).

## Review findings fixed in round 2
1. recoveryCodeStatus crashed for no-codes users → `?? []` guard.
2. server/recoveryCodes.test.js added (3 tests).
3. Stale untracked server/passwordReset.http.test.js (old link-based flow) deleted.
4. Local lockout never expired → recoveryAttemptsAt + RECOVERY_LOCKOUT_MS check.
5. Invalidation-warning copy added to Profile section intro; docs/auth-architecture-2026-09-10.md "Recovery codes" section added.

## Environmental traps hit (again)
- Reviewer's disk-space move of brave/opera to /tmp was wiped by restart_container → localBrowserRegistry.test failed. Re-extracted from official .debs (setup-script URLs, brave 1.97.56, opera-gx 136.0.6008.76). localBrowserRegistry.js in-tree diff adds opera-gx-stable candidate path — pre-existing RT1 work, not mine.
- webkit shared libs (libgstreamer etc.) wiped on EVERY container replacement; setup script re-installs on boot but manual test runs right after a restart need: apt-get update && apt-get install libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 libgstreamer-plugins-bad1.0-0 libflite1 libjxl0.11 libharfbuzz-icu0 libenchant-2-2 libmanette-0.2-0 libwoff1 libhyphen0 libxkbfile1 libxtst6 libsecret-1-0 → defectFixtures.test needs it.
- Full-tree node --test (147 suites) kills the container: zombie accumulation (rt1-branded-browsers-persistence.md) → run in ≤13-file chunks with --test-concurrency=1, restart container after. matrixService.queued + pilotFlow "test failed" flakes were zombie-pressure artifacts — both green on fresh container.

#15673 (email OTP live SMTP verification) still open, blocked on user entering QASE_MAIL_* credentials.
