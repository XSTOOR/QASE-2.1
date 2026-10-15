# Qase authentication and memory architecture

Qase now has a first-party account boundary that works in both supported run-store modes. A browser receives a random, opaque `qase_session` cookie. The server stores only its SHA-256 digest, and the cookie is `HttpOnly`, `SameSite=Lax`, path-scoped, and `Secure` in production. A separate readable `qase_csrf` cookie is paired with the `X-CSRF-Token` header for every authenticated write.

## Identity and isolation

- Accounts use the existing `users` and `organization_memberships` tables. Registration creates an owner membership in the configured Qase tenant and a profile row.
- PostgreSQL keeps auth sessions, profiles, and memory under the existing organization/project RLS settings. Run aggregates already have `created_by_user_id`; Qase now writes the authenticated user there and filters `get`/`list` reads by the request actor.
- Local development uses the same service contract with an atomic, mode-600 `.qase/auth.json` mirror. Passwords are scrypt hashes; raw passwords, session tokens, and CSRF values are never persisted in the run store.
- Legacy runs without an owner remain visible to the configured bootstrap owner only. A newly registered user starts with an empty run history.

## API contract

`POST /api/auth/register` accepts `email`, `password` (8–200 characters), and `displayName`. `POST /api/auth/login` rotates the user’s prior session and returns the public profile. `POST /api/auth/logout` revokes the server-side session. `GET /api/auth/me` returns the current identity and profile.

`GET /api/profile` and `PUT /api/profile` manage display name, timezone, locale, onboarding state, and bounded preferences. `GET /api/memory`, `PUT /api/memory`, and `DELETE /api/memory/:id` manage up to 100 user memory entries. Memory keys and values reject credential-shaped content and are capped at 80 and 4,000 characters respectively. Memory is passed to the agent as explicitly untrusted preference/fact context, never as system instructions.

## Password reset

`POST /api/auth/forgot-password` accepts `email` and always answers the same neutral 200 — the endpoint never confirms whether an account exists. When the account exists, a single-use reset token (32 random bytes, base64url) is issued; only its SHA-256 digest is stored (local: `.qase/auth.json`; PostgreSQL: `qase_auth_password_resets`, migration `037`). Tokens expire after 60 minutes; a new request supersedes any pending token for that account. `POST /api/auth/reset-password` accepts `token` and `password` (8–200 characters), marks the token used, updates the scrypt hash, and revokes every session for the account. Both endpoints are public (pre-auth) and share the login/register rate limits.

Delivery goes through the mailer module (`server/mailer.js`): SMTP via the `QASE_MAIL_*` environment variables (credentials never committed, never logged), or a dev/test mock transport that records messages to `.qase/outbox.json`. Reset links are only ever inside the email body — they appear in no API response, no UI state, and no log line. The mock transport refuses to buffer in production; a missing SMTP configuration there drops the mail with one redacted log entry rather than failing the request.

## Recovery codes

Single-use recovery codes let an account owner regain access without email. In Profile → Security, `POST /api/auth/recovery-codes` requires the account's current password and returns ten fresh codes (`XXXX-XXXX-XXXX` over a 32-character unambiguous alphabet, ~60 bits each) exactly once — only SHA-256 digests are ever persisted (local: `recoveryCodes` on the user record; PostgreSQL: `qase_auth_recovery_codes`, migration `039`, tenant RLS enforced). Generating a new batch invalidates every previous code. `GET /api/auth/recovery-codes` returns only remaining/total counts, never codes.

The login page exposes `POST /api/auth/recover` (public, throttled): it accepts `email` plus one unused code and answers the same neutral 400 for unknown accounts, accounts without codes, and wrong or already-used codes — the endpoint cannot be used to enumerate accounts. A matched code is consumed atomically inside the store lock (PostgreSQL additionally locks the user row `FOR UPDATE`), and the caller receives the same short-lived single-use reset authorization the email-OTP flow issues; `POST /api/auth/reset-password` then enforces the 8–200 character policy, marks the authorization used, and revokes every session for the account. Five wrong codes lock that account's recovery for 15 minutes; regenerating codes resets the counter. Raw codes appear in exactly one authenticated response and in no log line. Users with neither email access nor recovery codes must contact an administrator for identity-verified recovery — an email address alone can never reset a password.

## Operational controls

Set `QASE_AUTH_REQUIRED=false` only for a deliberately embedded compatibility host. Production defaults to required authentication whenever the auth service is configured. Keep `QASE_BOOTSTRAP_*` values stable so the configured tenant remains the same across restarts, run migrations before serving traffic, and keep `.qase` out of source control. PostgreSQL deployments should use the new migration `011_first_party_auth_profiles.sql` and a managed database role with RLS enforced.

The auth adapter is intentionally independent of the agent and browser runtime. This keeps account lifecycle, profile/memory reads, and run ownership testable without opening Chromium, while the existing QA, SQA, and Founder mode policies continue to govern every browser action.
