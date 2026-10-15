-- Qase PostgreSQL migration 031 (2027.03.0, #14633 NI02 Phase 1):
-- Server-side matrix runs — one shared workflow executed across many
-- device/browser profiles, with per-profile result records.
--
-- Follows the bugs template (028): tenant-scoped, RLS, additive.

BEGIN;

CREATE TABLE IF NOT EXISTS matrix_runs (
	-- #14649: text, not uuid — the service generates stable readable ids
	-- (`matrix-<ts36>-<uuid8>`), same convention as qa_runs.matrix_run_id
	-- (migration 032).
	id text PRIMARY KEY,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	title text NOT NULL,
	target_url text NOT NULL,
	status text NOT NULL DEFAULT 'pending',
		CONSTRAINT matrix_runs_status_valid CHECK (status IN ('pending', 'running', 'done', 'error', 'interrupted')),
	defaults_used boolean NOT NULL DEFAULT false,
	defaults_snapshot jsonb,
	requested_profiles jsonb NOT NULL DEFAULT '[]'::jsonb,
	requested_browsers jsonb NOT NULL DEFAULT '[]'::jsonb,
	item_count integer NOT NULL DEFAULT 0,
	owner_user_id text,
	created_at timestamptz NOT NULL DEFAULT now(),
	started_at timestamptz,
	finished_at timestamptz,
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS matrix_runs_tenant_created_idx
	ON matrix_runs (organization_id, project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS matrix_run_items (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	matrix_run_id text NOT NULL REFERENCES matrix_runs (id) ON DELETE CASCADE,
	ordinal integer NOT NULL,
	test_case_id text NOT NULL,
	environment_id text NOT NULL,
	profile_id text,
	platform text NOT NULL,
	device text NOT NULL,
	os text NOT NULL,
	os_version text NOT NULL,
	browser text NOT NULL,
	browser_code text NOT NULL,
	browser_version text NOT NULL,
	device_type text,
	status text NOT NULL DEFAULT 'PENDING',
		CONSTRAINT matrix_run_items_status_valid CHECK (
			status IN ('PENDING', 'RUNNING', 'PASSED', 'FAILED', 'NOT_RUN',
			           'UNAVAILABLE', 'NOT_SUPPORTED', 'BLOCKED', 'ERROR')
		),
	reason text,
	session_id text,
	verdict text,
	error text,
	findings jsonb NOT NULL DEFAULT '[]'::jsonb,
	started_at timestamptz,
	finished_at timestamptz,
	duration_ms integer,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT matrix_run_items_unique_ordinal UNIQUE (organization_id, project_id, matrix_run_id, ordinal)
);

CREATE INDEX IF NOT EXISTS matrix_run_items_run_idx
	ON matrix_run_items (organization_id, project_id, matrix_run_id, ordinal);

ALTER TABLE matrix_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS matrix_runs_tenant_isolation ON matrix_runs;
CREATE POLICY matrix_runs_tenant_isolation ON matrix_runs
	USING (
		organization_id::text = current_setting('qase.organization_id', true)
		AND project_id::text = current_setting('qase.project_id', true)
	);

ALTER TABLE matrix_run_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS matrix_run_items_tenant_isolation ON matrix_run_items;
CREATE POLICY matrix_run_items_tenant_isolation ON matrix_run_items
	USING (
		organization_id::text = current_setting('qase.organization_id', true)
		AND project_id::text = current_setting('qase.project_id', true)
	);

COMMIT;
