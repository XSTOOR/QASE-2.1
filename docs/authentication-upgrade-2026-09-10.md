# Authentication and private workspaces

Implemented a direct, responsive sign-in and registration page with **CREATED FOR DRYTIS**, keyboard-accessible inputs, password visibility, validation, pending states, and clear errors. The application remains hidden and inert until authentication. The account dialog supports profile editing, password changes, and creating/deleting agent memory.

## Account isolation

- Each account owns its runs, profile, memory, and model configuration. This is application-level workspace isolation in a shared deployment, not a separate container or server per user.
- Fixed a PostgreSQL in-flight cache path that could return another account's run. Unauthorized reads also no longer dispose that account's cached browser runtime. Browser suspension and configuration invalidation respect account ownership.
- Model settings no longer inherit another user's or the server's API credentials. Each user configures their endpoint in Settings. Existing global configuration is preserved for legacy execution; it is not automatically copied to accounts.
- Configuration is encrypted with AES-256-GCM and bound to the user ID as authenticated data. PostgreSQL stores the encrypted envelope on the RLS-protected profile; local development stores it in the account record. API responses expose only a short key hint.
- Agent execution loads the owning user's settings and memory, including background worker execution. Per-run Chromium contexts and scratch directories remain the browser execution boundary.
- Shared ambient AWS credentials are unavailable through the private-workspace Bedrock provider setting.

## Authentication behavior

- Retains scrypt password hashes, random session tokens stored as SHA-256 hashes, HttpOnly cookies, SameSite protection, and CSRF validation. Production cookies are Secure.
- Sign-in rotates the account's session. Password changes require the current password and revoke that account's sessions in the deployment. Sign-out clears cookies and reloads the page to discard account data and live connections.
- SSE connections revalidate authentication on the heartbeat (15 seconds by default), closing on expiration, revocation, or validation failure.
- Authentication attempts are bounded per IP (40) and account (10) per 15 minutes. Local development uses a bounded in-memory limiter; PostgreSQL deployments share atomic counters across replicas.
- New self-registered accounts receive the developer role, not organization owner. Existing account roles are preserved.
- Disabled local accounts cannot log in. Unknown-email checks use the password hashing path. Unexpected authentication failures return a generic message rather than backend exception details.
- Local account writes are serialized, restored in memory after persistence failures, and atomically renamed. PostgreSQL remains the required choice for multiple application processes.

## Validation

- Full Node suite: **436 tests, 430 passed, 6 skipped, 0 failed**.
- Real Chromium test: registration, login, desktop/mobile layout, profile edits, memory, per-user model settings, cross-account run denial, CSRF rejection, password rotation, and logout passed.
- Added regression coverage for the in-flight PostgreSQL cache isolation bug, password revocation, settings durability/encryption, account-bound ciphertext, missing production encryption keys, and rate-limit expiry.
- Browser test command: `node scripts/test-auth-browser.mjs` (also `npm run test:auth`). It starts an isolated temporary local server and removes its test accounts afterward. Screenshots are in `artifacts/auth`.
- The six existing infrastructure/browser integration tests remain skipped by the default suite. A live PostgreSQL/Redis deployment was not available for this change; migration and distributed deployment validation are still required before release.

## Production rollout requirements

1. Back up the database and apply migration **012_account_settings** using the repository migration command before deploying the API and workers together.
2. Set `QASE_SECRETS_MASTER_KEY` to the same secret-manager-managed, base64url-encoded 32-byte key on every API and worker process. Preserve and back up this key separately; losing it loses access to saved model credentials. Development generates `.qase/auth.json.key`; never commit this file. Changing the key requires decrypting/re-encrypting existing envelopes.
3. Use PostgreSQL, TLS, `NODE_ENV=production`, and `QASE_AUTH_REQUIRED=true`. Configure trusted proxy behavior explicitly; do not rely on arbitrary forwarded headers. Protect database backups and local files with OS access controls.
4. Validate migration 012, shared authentication throttling, RLS, worker settings/memory loading, and session revocation against the deployed PostgreSQL/Redis topology.
5. Email verification, forgotten-password recovery via an email provider, MFA/SSO, and dedicated per-user container provisioning are **not implemented by this change**. The password-change flow requires the current password. Do not advertise those capabilities or treat this report as certification for public production deployment.

The local preview uses the file-backed development adapter. No production deployment or GitHub push was performed.
