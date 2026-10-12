# Recon for single-use recovery-codes feature (planning, 2026-10)

Goal: add single-use recovery codes to the existing OTP password-reset flow (#15673).

## Key facts (verified with line refs)
- Local store user record: server/auth.js:266 — `{ id, email, displayName, passwordHash, status, role, createdAt, updatedAt, profile, settings?, passwordReset? }`; `passwordReset` shape at :316-322/:350-354/:372 (otpHash/authorizationHash sha256-hex, expiresAt, attempts, requests[], usedAt).
- Helpers (not exported): tokenHash sha256-hex (:118), newToken randomBytes(32) base64url (:122), passwordRecord scrypt (:87), withLock mutex w/ snapshot rollback (:216-223). GOTCHA: attempt counters must be returned as {error} and thrown AFTER withLock, else rolled back (:342-345).
- Constants: PASSWORD_RESET_OTP_TTL_MS=5min (:15), OTP_MAX_ATTEMPTS=5 (:17), AUTH_TTL_MS=10min (:19), PASSWORD_MIN_LENGTH=8 (:10).
- POST /api/auth/password: app.js:449-456 → changePassword(userId, {currentPassword,password}); success 204 + clearAuthCookies; wrong current pw → 401 invalid_credentials. Frontend: public/app.js:8023-8026 (raw $('id') + accountAction :8009); form in #profile-dialog index.html:1419-1420 (no dedicated Security section; dialog section separated by <hr><h3>).
- Reset flow: routes app.js:464-499 (forgot-password / verify-reset-otp / reset-password, neutral responses, mailer mock/SMTP). Frontend: 4 auth cards in index.html:18-105 (#forgot-panel/:58, #otp-panel/:72, #reset-panel/:87), el refs app.js:210-233, showAuthCard app.js:6745-6755 (sign-in panel found by :not() selector :6749), resetAuthorization/resetEmail module state :6742-6743, deep link #reset-password hash :7901-7910.
- Throttle: app.js:356-371 — POST paths list :358 (login/register/password/forgot/reset/verify-reset-otp), ip: 40 + account:<email>: 10 per 15min, 429 + Retry-After 900. createAuthThrottle in server/authThrottle.js (15-min Map windows). NEW ROUTES MUST BE ADDED to array at app.js:358 and, if pre-auth, allowlist at app.js:312-314.
- Sessions: local single-session-per-user (issueSession revokes prior, auth.js:276; sessions[] = {id,userId,tokenHash,createdAt,expiresAt}); revoke-all is inline filter (:303,:374) — no named revokeAll fn. PG qase_auth_sessions revoked_at=:416/:433/:543.
- PG reset table: migrations 037_password_resets.sql (token_hash char(64) UNIQUE, FK CASCADE, FORCE RLS, tenant policy current_setting qase.organization_id/project_id) + 038 (kind 'otp'|'authorization'|'link' default, attempts int, idx user_id,kind,used_at). PG flow: requestPasswordReset auth.js:476, verifyResetOtp :497 (FOR UPDATE), resetPassword :529.
- migrations.test.js EDITS FOR 039: versions array :58; names array :66-105 (ends 'password_reset_otp' :104); '00N' string array :181; applied versions :182; currentVersion 38→39 :183; counts :184-186,:190; [39,name] pair :192-231; also :246 currentVersion. Optional content asserts near :165-169.
- passwordReset.test.js fixture pattern: mkdtemp cwd, real createLocalAuthService({tenantContext: DEFAULT_TENANT_CONTEXT, file: cwd/auth.json}) wrapped in Proxy stubbing consumeAuthAttempt→true (:30-31), mock mailer QASE_MAIL_MODE=mock, createApplication with noop service stubs, listen(0), process.chdir(cwd) for outbox; outboxLast() regexes 6-digit OTP from email text. Key assertions: OTP never in API, neutral unknown email, resend supersedes, 429 attempt lock, failed weak-pw does NOT consume authorization, single-use reuse 400, only sha256 verifiers in auth.json, sessions revoked, resend limit 3/15min.
- Styling conventions: .account-dialog styles.css:9253-9256; .auth-card inputs :9245; .auth-hint :9250; .auth-error :9252; busy = disabled + aria-busy on form.

## Design pointers
- Local: recoveryCodes: [{codeHash, usedAt?}] on user record; PG: reuse qase_auth_password_resets with new kind='recovery_code' or 039 table mirroring 037.
- Codes shown once to logged-in user (no email needed); verify via sha256 lookup like resetPassword :364-365.
- UI inside #profile-dialog (accountAction + $('id') pattern) and/or fifth .auth-panel card (update showAuthCard + :not() selector).
