-- Qase PostgreSQL migration 038: Email-OTP password reset (#15673).
-- The password-resets table now stores two kinds of verifiers:
--   'otp'           — 6-digit email code, 5-minute expiry, attempt-limited
--   'authorization' — short-lived (10 min) single-use reset authorization
--                     issued after a verified OTP
-- Only SHA-256 hashes are stored; raw OTPs/authorizations never touch the DB.
ALTER TABLE qase_auth_password_resets
	ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'link',
	ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

-- Legacy 'link'-kind rows keep working under the default; new rows always set
-- the kind explicitly.
CREATE INDEX IF NOT EXISTS idx_qase_auth_password_resets_user
	ON qase_auth_password_resets (user_id, kind, used_at);
