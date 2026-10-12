# Recon for password min-length (12→8) + forgot-password flow (2026-10)

## Password min-length = 12, all enforcement points
- `server/auth.js:10` `const PASSWORD_MIN_LENGTH = 12;` — sole backend constant; error string built at line 53: `Password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.` (code `weak_password`, 400). Used by `validatePassword` (register + changePassword in BOTH local and Postgres stores).
- `public/index.html:45` login/register input `minlength="12"`; `:51` hint "Use at least 12 characters when creating an account."; `:1373` profile change-password `#new-password` `minlength="12"`.
- `public/app.js:6653` `el.authPassword.minLength = register ? 12 : 1;` (renderAuthMode).
- Docs: `docs/auth-architecture-2026-09-10.md:14` "(12–200 characters)".
- Tests use ≥12-char passwords throughout (`server/auth.test.js`, `server/pilotFlow.test.js` 'a-very-long-password-123', `scripts/test-auth-browser.mjs` 'a strong original password'). No test asserts the 12 boundary.

## Auth architecture
- Express 5 ESM backend (`server/index.js` → `createApplication` in `server/app.js`); auth routes at app.js:369-452 (`/api/auth/register|login|me|logout|password`) + invites at 2299-2321. Throttle middleware app.js:353-367 (40/IP, 10/account per 15 min; routes login/register/password).
- Two auth backends in `server/auth.js`: `createLocalDataStore` (`.qase/auth.json`, atomic write) and `createPostgresAuthService` (pg pool, RLS via set_config qase.organization_id/project_id).
- scrypt N=16384,r=8,p=1, format `scrypt$N$r$p$salt$digest` base64url. Sessions: random 32-byte base64url token, SHA-256 stored; cookies `qase_session` (HttpOnly) + `qase_csrf` (readable) + X-CSRF-Token header on writes. Session TTL 30d.
- **No reset_token/reset_expires fields anywhere** — not in users table (migration 001), not in local auth.json schema, not in migrations. New PG migration + local-store field needed.
- Existing pattern to copy: `server/invites.js` (single-use expiring codes, local JSON file) and `qase_auth_sessions`/`drytis_token_exchanges` (token_hash + expires_at single-use rows).

## Email: NONE. No SMTP/nodemailer/mailer lib or env keys. Only outbound notification channel is `server/telegramNotifier.js` (Bot API via fetch). No mail env keys in `.env.example` (only QASE_OPERATOR_EMAIL). Forgot-password needs a mail sender decision (SMTP lib or API-based, e.g. Resend) from scratch.

## Login UI
- Single-page app: `public/index.html` `#auth-gate` section (lines 18-58), styles in `public/styles.css` (`.auth-gate` 9229, `.auth-card` 9240, `.auth-hint` 9250, `.auth-switch` 9251) + `public/entry-terminal.css` (terminal theme). Login/registration are the SAME form (`#auth-form`) toggled by `authRegisterMode` in `public/app.js` (renderAuthMode ~6639, submit handler 6679). A "Forgot password?" link belongs under the password field / near `#auth-switch` (line 55 index.html).
- No forgot/reset routes or UI exist. Docs/auth notes explicitly defer password reset to post-launch backlog (`.drytis/specs/complete-customer-journey.md:45`, `docs/authentication-upgrade-2026-09-10.md:38`).

## Tests
- `node:test` runner: `npm test` = `node --test server/*.test.js server/postgres/*.test.js server/controlPlane/*.test.js public/*.test.js`. Auth unit: `server/auth.test.js`, `server/authMemoryQuota.test.js`; HTTP-level: `server/app.test.js` (uses in-memory fake auth service, see createMemoryAuth), `server/securityRegression.test.js`, `server/pilotFlow.test.js`; browser: `scripts/test-auth-browser.mjs` (`npm run test:auth`).
- Note: memory `review-14025-react-phase3.md` mentions a React AuthGate with minLength 12:1 — that src/ tree does NOT exist in the current workspace (no src/**/*.tsx); it was an uncommitted branch. Current UI is the vanilla public/ app.
