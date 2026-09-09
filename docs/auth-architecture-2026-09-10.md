# Qase authentication and memory architecture

Qase now has a first-party account boundary that works in both supported run-store modes. A browser receives a random, opaque `qase_session` cookie. The server stores only its SHA-256 digest, and the cookie is `HttpOnly`, `SameSite=Lax`, path-scoped, and `Secure` in production. A separate readable `qase_csrf` cookie is paired with the `X-CSRF-Token` header for every authenticated write.

## Identity and isolation

- Accounts use the existing `users` and `organization_memberships` tables. Registration creates an owner membership in the configured Qase tenant and a profile row.
- PostgreSQL keeps auth sessions, profiles, and memory under the existing organization/project RLS settings. Run aggregates already have `created_by_user_id`; Qase now writes the authenticated user there and filters `get`/`list` reads by the request actor.
- Local development uses the same service contract with an atomic, mode-600 `.qase/auth.json` mirror. Passwords are scrypt hashes; raw passwords, session tokens, and CSRF values are never persisted in the run store.
- Legacy runs without an owner remain visible to the configured bootstrap owner only. A newly registered user starts with an empty run history.

## API contract

`POST /api/auth/register` accepts `email`, `password` (12–200 characters), and `displayName`. `POST /api/auth/login` rotates the user’s prior session and returns the public profile. `POST /api/auth/logout` revokes the server-side session. `GET /api/auth/me` returns the current identity and profile.

`GET /api/profile` and `PUT /api/profile` manage display name, timezone, locale, onboarding state, and bounded preferences. `GET /api/memory`, `PUT /api/memory`, and `DELETE /api/memory/:id` manage up to 100 user memory entries. Memory keys and values reject credential-shaped content and are capped at 80 and 4,000 characters respectively. Memory is passed to the agent as explicitly untrusted preference/fact context, never as system instructions.

## Operational controls

Set `QASE_AUTH_REQUIRED=false` only for a deliberately embedded compatibility host. Production defaults to required authentication whenever the auth service is configured. Keep `QASE_BOOTSTRAP_*` values stable so the configured tenant remains the same across restarts, run migrations before serving traffic, and keep `.qase` out of source control. PostgreSQL deployments should use the new migration `011_first_party_auth_profiles.sql` and a managed database role with RLS enforced.

The auth adapter is intentionally independent of the agent and browser runtime. This keeps account lifecycle, profile/memory reads, and run ownership testable without opening Chromium, while the existing QA, SQA, and Founder mode policies continue to govern every browser action.
