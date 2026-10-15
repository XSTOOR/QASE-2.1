-- Qase PostgreSQL migration 023: Apple device & browser compatibility environments.
--
-- First-class environment entity for the Apple compatibility matrix
-- (iPhone / iPad / macOS × OS versions × browsers × browser versions).
-- Environments are seeded deterministically from server/environmentCatalog.js
-- and referenced by runs via environment_id. Runs additionally snapshot the
-- full environment record at start so history and reports never mutate when
-- the catalog later changes or an environment is deprecated.

CREATE TABLE environments (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	env_id text NOT NULL,
	platform text NOT NULL,
	platform_label text NOT NULL,
	device text NOT NULL,
	os text NOT NULL,
	os_version text NOT NULL,
	browser text NOT NULL,
	browser_code text NOT NULL,
	browser_version text NOT NULL,
	device_type text NOT NULL,
	screen_size text NOT NULL,
	execution_provider text NOT NULL DEFAULT 'browserstack',
	is_real_device boolean NOT NULL DEFAULT true,
	active boolean NOT NULL DEFAULT true,
	browserstack_capabilities jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT environments_project_fk
		FOREIGN KEY (organization_id, project_id)
		REFERENCES projects (organization_id, id) ON DELETE RESTRICT,
	CONSTRAINT environments_tenant_project_env_id_unique
		UNIQUE (organization_id, project_id, env_id),
	CONSTRAINT environments_platform_valid CHECK (platform IN ('ios', 'ipados', 'macos')),
	CONSTRAINT environments_device_type_valid CHECK (device_type IN ('mobile', 'tablet', 'desktop')),
	CONSTRAINT environments_execution_provider_valid CHECK (execution_provider IN ('browserstack', 'local')),
	CONSTRAINT environments_capabilities_object CHECK (jsonb_typeof(browserstack_capabilities) = 'object')
);

CREATE INDEX environments_tenant_env_id
	ON environments (organization_id, project_id, env_id);

CREATE INDEX environments_tenant_filters
	ON environments (organization_id, project_id, platform, browser, os_version, active);

-- Row-level security, same tenant predicate pattern as every other table.
ALTER TABLE environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments FORCE ROW LEVEL SECURITY;
CREATE POLICY environments_tenant_scope ON environments
	FOR ALL
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);

-- Runs reference an environment and freeze a snapshot of it at run start.
ALTER TABLE qa_runs ADD COLUMN IF NOT EXISTS environment_id text;
ALTER TABLE qa_runs ADD COLUMN IF NOT EXISTS environment_snapshot jsonb;
ALTER TABLE qa_runs DROP CONSTRAINT IF EXISTS qa_runs_environment_snapshot_object;
ALTER TABLE qa_runs ADD CONSTRAINT qa_runs_environment_snapshot_object
	CHECK (environment_snapshot IS NULL OR jsonb_typeof(environment_snapshot) = 'object');

CREATE INDEX qa_runs_environment_id
	ON qa_runs (organization_id, project_id, environment_id)
	WHERE environment_id IS NOT NULL;
