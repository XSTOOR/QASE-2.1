-- Qase PostgreSQL migration 011: first-party credentials, profiles, and memory.

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE qase_auth_sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE qase_auth_sessions ALTER COLUMN last_seen_at SET DEFAULT CURRENT_TIMESTAMP;
UPDATE qase_auth_sessions SET last_seen_at = COALESCE(last_seen_at, created_at) WHERE last_seen_at IS NULL;

CREATE TABLE qase_user_profiles (
	user_id uuid PRIMARY KEY,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	timezone text NOT NULL DEFAULT 'UTC',
	locale text NOT NULL DEFAULT 'en',
	preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
	onboarding_complete boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT qase_user_profiles_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT qase_user_profiles_project_fk FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id) ON DELETE CASCADE,
	CONSTRAINT qase_user_profiles_timezone_size CHECK (char_length(btrim(timezone)) BETWEEN 1 AND 100),
	CONSTRAINT qase_user_profiles_locale_size CHECK (char_length(btrim(locale)) BETWEEN 2 AND 20),
	CONSTRAINT qase_user_profiles_preferences_object CHECK (jsonb_typeof(preferences) = 'object')
);

CREATE TABLE qase_memory_entries (
	id uuid PRIMARY KEY,
	user_id uuid NOT NULL,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	key text NOT NULL,
	value text NOT NULL,
	scope text NOT NULL DEFAULT 'user',
	kind text NOT NULL DEFAULT 'fact',
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT qase_memory_entries_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT qase_memory_entries_project_fk FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id) ON DELETE CASCADE,
	CONSTRAINT qase_memory_entries_key_valid CHECK (key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
	CONSTRAINT qase_memory_entries_value_size CHECK (char_length(value) BETWEEN 1 AND 4000),
	CONSTRAINT qase_memory_entries_scope_valid CHECK (scope IN ('user', 'project')),
	CONSTRAINT qase_memory_entries_kind_valid CHECK (kind IN ('preference', 'fact', 'instruction')),
	CONSTRAINT qase_memory_entries_user_key_unique UNIQUE (user_id, scope, key)
);

CREATE INDEX qase_memory_entries_user_recent ON qase_memory_entries (user_id, updated_at DESC);

ALTER TABLE qase_user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE qase_user_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY qase_user_profiles_tenant_scope ON qase_user_profiles FOR ALL
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);

ALTER TABLE qase_memory_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE qase_memory_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY qase_memory_entries_tenant_scope ON qase_memory_entries FOR ALL
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);
