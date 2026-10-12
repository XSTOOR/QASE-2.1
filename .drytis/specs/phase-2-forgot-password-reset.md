# Phase 2 — Forgot password & email reset flow (SMTP, mock-testable)

## Goal
A "Forgot password?" link on the login (auth-gate) card lets a user submit their registered email and receive a secure, expiring, single-use reset link by email. The reset page has New Password and Confirm Password fields and enforces the 8-char minimum. Uses the existing auth architecture (Express 5, scrypt hashing, dual local-JSON + PostgreSQL stores). SMTP credentials live ONLY in env vars; never committed. A mock mail transport makes the flow testable end to end without real SMTP. Reset links are never rendered in the UI and never written to production logs.

## Architecture (preserves existing patterns)

### Mailer — new `server/mailer.js`
- Env: `QASE_MAIL_MODE` (`mock` | `smtp`; default `mock` when SMTP env is absent), `QASE_MAIL_HOST`, `QASE_MAIL_PORT`, `QASE_MAIL_USER`, `QASE_MAIL_PASSWORD` (secret), `QASE_MAIL_FROM`.
- SMTP sending via `nodemailer` (added to package.json). Follows the conventions of `server/telegramNotifier.js` (plain fetch/module config from env, no framework magic).
- Mock transport (`QASE_MAIL_MODE=mock`): stores sent messages in a dev-only outbox — in-memory + optionally `.qase/outbox.json` (dev data dir, already git-ignored pattern like `.qase/auth.json`). Used by tests and by the operator to retrieve links during verification. NEVER active in production: if `NODE_ENV=production` and SMTP env is missing, requests still return success (see anti-enumeration) and the mail is dropped with a single redacted log line containing NO token/link.
- Errors from SMTP are logged redacted (recipient + message id only, never body/token/link).

### Reset tokens — both stores
- Local (`server/auth.js` `createLocalDataStore`): extend `.qase/auth.json` user records with `passwordReset = { tokenHash, expiresAt, usedAt? }` (backward compatible; absent field = no reset pending).
- PostgreSQL: migration `server/postgres/migrations/037_password_reset.sql` — `qase_auth_password_resets` table: `id`, `user_id` FK, `token_hash char(64)` (sha256 hex, mirroring `qase_auth_sessions` migration 004), `expires_at`, `used_at`, `created_at`; indexes on `token_hash`, `user_id`; RLS keyed like existing auth tables. Must satisfy `server/postgres/migrations.test.js` shape assertions.
- Token: 32-byte random, base64url, single-use, 60-minute expiry. Only the SHA-256 hash is stored. Requesting a new link invalidates (marks used / replaces) any prior pending token for that user.

### API routes — `server/app.js`
- `POST /api/auth/forgot-password` — body `{ email }`. Always returns 200 `{"message":"If an account exists for that email, a reset link has been sent."}` whether or not the account exists (anti-enumeration). Sends email when the account exists.
- `POST /api/auth/reset-password` — body `{ token, password }`. Validates token (exists, unexpired, unused), enforces `validatePassword` (8-char min via Phase 1 constant), then updates the password hash and marks token used; revokes all sessions for the user (same as changePassword). Errors: 400 `invalid_or_expired_token`, 400 `weak_password`, generic wording that does not confirm token validity state.
- Both added to the public pre-auth path allowlist (`app.js:310`) and the auth throttle allowlist (`app.js:354`, e.g. `'/forgot-password','/reset-password'`) so they are rate-limited like login/register.
- No CSRF token required (pre-auth endpoints, consistent with register/login), but rate-limited and single-use.
- Reset link format: `${APP_ORIGIN}/#reset-password?token=...` served by the SPA (hash route — no server route needed).

### Frontend — `public/index.html` + `public/app.js`
- Auth-gate card: add "Forgot password?" link (`.auth-switch`-style anchor) shown in login mode between hint and submit, hidden in register mode. Preserves existing card layout/styling (terminal theme).
- Forgot view: same auth card swaps to a "Reset your password" form (email field + submit + back-to-login link) — reuses `.auth-card` markup/CSS, no new layout.
- Reset view (`#/reset-password?token=...`): New Password + Confirm Password fields, `minlength="8"`, helper text "Use at least 8 characters.", inline validation (match + length) before submit; success/error states styled like existing auth errors.
- The token is read from the URL only transiently for the POST; it is never displayed, echoed in the UI, or logged.
- After success: message "Password updated. You can now sign in." and return to login form.

### Security requirements
- Reset link/token NEVER rendered in the UI or returned by any API response.
- No token/link in logs at any level (mock outbox file is dev/test-only and outside git).
- Single-use enforced server-side; reuse returns the same generic 400.
- 60-minute expiry enforced server-side.
- Anti-enumeration on forgot-password.
- All sessions revoked on successful reset.
- SMTP credentials only via env (`QASE_MAIL_*`), `QASE_MAIL_PASSWORD` marked secret. Never in code, docs, or committed files. `.env.example` gets placeholder names with empty values only.

## Tests
- `server/auth.test.js` / new `server/passwordReset.test.js`: token issue→use lifecycle; expired token rejected; reused token rejected; 7-char password on reset rejected / 8-char accepted; sessions revoked after reset; both local + PG services.
- `server/app.test.js`: HTTP-level — forgot returns 200 for unknown email (no leak), reset route public (works pre-auth), throttle applies, mock mailer receives the link.
- `server/securityRegression.test.js`: reset endpoints rate-limited; token not present in any response body; no reset link in server logs during test run.
- `scripts/test-auth-browser.mjs` (or new `test-reset-browser.mjs`): full browser flow with mock mailer — login page → Forgot password? → enter email → read link from mock outbox (test-side, file read, not UI) → open reset page → set 8-char password → login with new password succeeds.
- Mock outbox reading happens in test code only, never surfaced in app UI.

## Acceptance criteria (observable in the running app, mock mailer)
- [ ] "Forgot password?" link visible on the login card (login mode only)
- [ ] Submitting a registered email yields the neutral success message regardless of whether the account exists
- [ ] Submitting an unregistered email gives the identical message (no account-existence leak)
- [ ] The emailed (mock outbox) reset link works once: reset page shows New Password + Confirm Password fields
- [ ] Reset with a 7-character password is rejected; 8-character password is accepted
- [ ] Mismatched confirm password is blocked before submit
- [ ] After reset, the old password no longer logs in and the new password does
- [ ] Reusing or revisiting a used/expired reset link fails with a generic error
- [ ] Reset links/tokens appear nowhere in the app UI, API responses, or server logs
- [ ] With `QASE_MAIL_MODE=smtp` configured externally, the same code path sends real SMTP mail (verified later by customer with live credentials)

## Edge cases
- Email casing/whitespace normalized before lookup (match login behavior).
- Concurrent requests for same user: latest token wins, previous invalidated.
- Token URL-safety (base64url) through hash routing.
- SMTP failure mid-flow: user still sees neutral success (no leak, no retry storm); error logged redacted.
- Production without SMTP config: mail dropped (redacted log), neutral success returned, no crash.
