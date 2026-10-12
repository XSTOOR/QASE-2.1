# Recovery-Codes Password Recovery — Phase Spec

Ticket group: Phase RC1–RC4 (one ticket per phase below).
Related: #15673 (email OTP recovery — stays open separately, unchanged and available).

## Goal
Single-use recovery codes for password recovery without email/SMS:
- Profile → Security: verify current password → generate 10 crypto-secure codes → shown ONCE (copy/download + save instructions). Regeneration invalidates all previous codes.
- Login page: "Recover with a recovery code" → email + one unused code → short-lived single-use authorization → new password (8-char min, front + back).
- Atomic code consumption; all sessions revoked on successful reset; rate-limited; neutral errors (no account-existence oracle); codes never in logs/API after generation.
- Users with no codes get a "contact an administrator" message; email+alone NEVER resets.

## Architecture (decided)
- **Reuse `/api/auth/reset-password`** (app.js:464-499) as-is: it already consumes a single-use `authorizationHash`, enforces 8-char min, revokes sessions. Recovery verification only has to ISSUE that same authorization token (10-min TTL, PASSWORD_RESET_AUTH_TTL_MS). No new reset endpoint.
- **Local store** (`server/auth.js`): user record gains `recoveryCodes: [{codeHash, usedAt?}, …]` + `recoveryAttempts` counter. Generation replaces the whole array (invalidates all previous). Consumption marks `usedAt` on the matched hash inside `withLock` — follow the documented gotcha: return `{error}` from inside the lock, throw AFTER release, else the snapshot rollback discards the counter (auth.js:216-223, :342-345).
- **Postgres**: new migration `039_recovery_codes.sql` → `qase_auth_recovery_codes` (id, user_id FK CASCADE, code_hash char(64) UNIQUE, kind/generated_at, used_at, used_for, tenant columns + FORCE RLS mirroring 037). Migration-count assertions in `server/postgres/migrations.test.js` per recon line refs (:58, :66-105, :181-186, :190, :192-231, :246).
- **Codes**: 10 × `XXXX-XXXX-XXXX` (12 chars from a 32-char no-ambiguous alphabet via `crypto.randomInt`), SHA-256 hex stored. ~60 bits entropy each.
- **API**:
  - `POST /api/auth/recovery-codes` (AUTHENTICATED; body `{currentPassword}`) → 401 wrong password; else returns `{codes: [...10 plaintext...], generatedAt}` — the ONLY time plaintext leaves the server. Never logged.
  - `POST /api/auth/recover` (PRE-AUTH; body `{email, code}`) → neutral 200/400 responses identical for unknown email / no codes / wrong code / exhausted; on match: consume code atomically + return `{authorization}` (same shape as verify-reset-otp). Adds BOTH new paths to throttle array app.js:358; `recover` also to pre-auth allowlist :312-314.
  - Per-account recovery attempt counter: 5 wrong codes / 15 min, mirroring OTP attempts.
- **UI**:
  - Profile dialog (`#profile-dialog`, index.html:1419 area): new Security subsection styled like existing `<hr><h3>` blocks — "Recovery codes" row with count-remaining + "Generate codes…" button → current-password prompt (existing `.account-dialog` styling, app.js `accountAction` pattern :8009) → show-once panel with the 10 codes (mono font), Copy all / Download .txt buttons, and "Store them somewhere safe — they're shown only once" instructions; regeneration warning ("this invalidates all previous codes").
  - Login gate: 5th auth card `#recover-panel` linked under "Forgot password?" in the sign-in panel; asks email + code (hint: format XXXX-XXXX-XXXX); on success switches to the EXISTING `#reset-panel` (New/Confirm password, 8-char minlength already present) carrying `resetAuthorization`. Update `showAuthCard` `:not()` selector (app.js:6745-6755). Forgot card gains a small "No codes? Recover with a recovery code" link, and vice versa; users with neither get copy pointing to the administrator.
- **Neutral copy/log rules**: mailer logging precedent (subject only) applies — no code material in any log line; API responses for `recover` carry one generic message for every failure mode.

## Files to change
- `server/auth.js` — constants (RECOVERY_ATTEMPTS_MAX=5), `generateRecoveryCodes(userId, …)`, `recoverWithCode({email, code})` on local + `createPostgresAuthService`.
- `server/postgres/migrations/039_recovery_codes.sql`, `server/postgres/migrations.test.js` (38→39).
- `server/app.js` — 2 routes, throttle array, pre-auth allowlist.
- `public/index.html`, `public/app.js`, `public/styles.css` — Security subsection + recover card.
- `server/recoveryCodes.test.js` (new) — full acceptance suite.
- `docs/` — short "Recovery codes" section in the auth docs.

## Acceptance criteria (running app)
- [ ] Logged-in user in Profile → Security must enter current password before codes appear; wrong password shows an error and reveals nothing.
- [ ] 10 codes are shown once with Copy-all and Download options and save instructions; after leaving the panel they cannot be retrieved again.
- [ ] Only SHA-256 hashes are persisted (verified in .qase/auth.json / PG rows); no plaintext code appears in any log or later API response.
- [ ] "Recover with a recovery code" on the login page: email + one valid unused code → authorization → new password set → login with new password works; OLD password is rejected afterwards.
- [ ] A used code cannot be reused (second attempt rejected).
- [ ] Regenerating codes invalidates ALL previous codes (old codes rejected, new ones accepted).
- [ ] 7-char password rejected front and back; 8-char accepted.
- [ ] All existing sessions for the user are revoked after a successful recovery reset.
- [ ] Unknown email, account with no codes, and wrong code all return the SAME neutral response; after 5 wrong codes the account's recovery is locked 15 min.
- [ ] Email OTP recovery ("Forgot password?") still works exactly as before (mock mode in tests).
- [ ] Users without recovery codes see guidance to contact an administrator; email-alone reset without OTP/code is impossible.

## Tests
- `server/recoveryCodes.test.js` (mirror passwordReset.test.js fixture pattern, recon §15): full happy path; wrong code; reuse rejection; regeneration invalidation; 7-char rejection without consuming authorization; session revocation; neutral responses (unknown email = no-code = wrong code); attempt lockout 429; hashes-only persistence scan; codes never in API/log after generation; OTP flow regression.
- Boundary: existing auth.test.js 8-char cases stay green; migrations 5/5 with 039.

## Edge cases
- Two concurrent `recover` calls with the same code → exactly one wins (withLock / FOR UPDATE).
- Password prompt for generation when user has `status !== 'active'` → refuse.
- Empty/whitespace code input, wrong-format code → same neutral error, no oracle.
- Download filename `qase-recovery-codes.txt` includes account email + date + warning line.
- Regenerate with zero remaining codes and with remaining codes — both invalidate everything prior.
