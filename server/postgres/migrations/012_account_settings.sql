-- Qase PostgreSQL migration 012
-- Encrypted account configuration inherits the profile's forced tenant RLS.
ALTER TABLE qase_user_profiles ADD COLUMN settings jsonb;

CREATE TABLE qase_auth_attempts (
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	key text NOT NULL,
	attempts integer NOT NULL,
	expires_at timestamptz NOT NULL,
	PRIMARY KEY (organization_id, project_id, key),
	FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX qase_auth_attempts_expiry ON qase_auth_attempts (expires_at);
ALTER TABLE qase_auth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE qase_auth_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY qase_auth_attempts_tenant ON qase_auth_attempts FOR ALL
	USING (organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid)
	WITH CHECK (organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid);
