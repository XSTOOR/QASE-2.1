-- Qase PostgreSQL migration 004: Drytis external identities and shared auth sessions.

CREATE TABLE drytis_identities (
	issuer text NOT NULL,
	subject text NOT NULL,
	organization_id uuid NOT NULL,
	user_id uuid NOT NULL,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_login_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (issuer, subject, organization_id),
	CONSTRAINT drytis_identities_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT,
	CONSTRAINT drytis_identities_membership_fk FOREIGN KEY (organization_id, user_id)
		REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT,
	CONSTRAINT drytis_identities_org_user_unique UNIQUE (issuer, organization_id, user_id)
);

CREATE TABLE drytis_token_exchanges (
	issuer text NOT NULL,
	jti text NOT NULL,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	user_id uuid NOT NULL,
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (issuer, jti),
	CONSTRAINT drytis_token_exchanges_project_fk FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id) ON DELETE RESTRICT,
	CONSTRAINT drytis_token_exchanges_membership_fk FOREIGN KEY (organization_id, user_id)
		REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE qase_auth_sessions (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	user_id uuid NOT NULL,
	token_hash char(64) NOT NULL,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	expires_at timestamptz NOT NULL,
	revoked_at timestamptz,
	CONSTRAINT qase_auth_sessions_project_fk FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id) ON DELETE RESTRICT,
	CONSTRAINT qase_auth_sessions_membership_fk FOREIGN KEY (organization_id, user_id)
		REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT,
	CONSTRAINT qase_auth_sessions_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX qase_auth_sessions_active_lookup
	ON qase_auth_sessions (organization_id, project_id, token_hash, expires_at)
	WHERE revoked_at IS NULL;
CREATE INDEX qase_auth_sessions_expiry
	ON qase_auth_sessions (organization_id, project_id, expires_at);
CREATE INDEX drytis_token_exchanges_expiry ON drytis_token_exchanges (expires_at);

ALTER TABLE drytis_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE drytis_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY drytis_identities_tenant_scope ON drytis_identities FOR ALL
	USING (organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid)
	WITH CHECK (organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid);

ALTER TABLE drytis_token_exchanges ENABLE ROW LEVEL SECURITY;
ALTER TABLE drytis_token_exchanges FORCE ROW LEVEL SECURITY;
CREATE POLICY drytis_token_exchanges_tenant_scope ON drytis_token_exchanges FOR ALL
	USING (organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid)
	WITH CHECK (organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid);

ALTER TABLE qase_auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE qase_auth_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY qase_auth_sessions_tenant_scope ON qase_auth_sessions FOR ALL
	USING (organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid)
	WITH CHECK (organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid);
