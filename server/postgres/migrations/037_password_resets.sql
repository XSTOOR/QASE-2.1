-- Qase PostgreSQL migration 037 — password reset tokens
-- Single-use, 60-minute-expiry password reset tokens. Mirrors qase_auth_sessions:
-- only the SHA-256 hex digest (char(64)) of the base64url token is stored.

CREATE TABLE qase_auth_password_resets (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	user_id uuid NOT NULL,
	token_hash char(64) NOT NULL,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	expires_at timestamptz NOT NULL,
	used_at timestamptz,
	CONSTRAINT qase_auth_password_resets_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT qase_auth_password_resets_project_fk FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id) ON DELETE CASCADE,
	CONSTRAINT qase_auth_password_resets_expiry CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX qase_auth_password_resets_token_hash_key ON qase_auth_password_resets (token_hash);
CREATE INDEX qase_auth_password_resets_user_idx ON qase_auth_password_resets (user_id);

ALTER TABLE qase_auth_password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE qase_auth_password_resets FORCE ROW LEVEL SECURITY;
CREATE POLICY qase_auth_password_resets_tenant_scope ON qase_auth_password_resets FOR ALL
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);
