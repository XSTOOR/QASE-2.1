-- Qase PostgreSQL migration 025: test cases with multi-environment assignment.
--
-- Test cases are reusable QA scenarios (title, steps, expected result, tags) assigned
-- to one or more testing environments. Runs link to a case via qa_runs.test_case_id;
-- the case + environment pair fully identifies an execution.

BEGIN;

CREATE TABLE IF NOT EXISTS test_cases (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	case_number text NOT NULL,
	title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
	description text,
	steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
	expected text,
	tags text[] NOT NULL DEFAULT '{}',
	environment_ids text[] NOT NULL DEFAULT '{}',
	deleted boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT test_cases_tenant_fk FOREIGN KEY (organization_id, project_id)
		REFERENCES projects (organization_id, id) ON DELETE CASCADE,
	CONSTRAINT test_cases_number_unique UNIQUE (organization_id, project_id, case_number)
);

CREATE INDEX IF NOT EXISTS test_cases_tenant_idx ON test_cases (organization_id, project_id) WHERE deleted = false;

-- Plain text link (no cross-table FK — the tenant-scoped unique on (org, project,
-- case_number) cannot back a global FK). The application validates the case exists
-- and the environment is assigned, mirroring how qa_runs.environment_id works.
ALTER TABLE qa_runs
	ADD COLUMN IF NOT EXISTS test_case_id text;

-- RLS mirrors the environments table: tenant-scoped via qase.organization_id/project_id.
ALTER TABLE test_cases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS test_cases_tenant_isolation ON test_cases;
CREATE POLICY test_cases_tenant_isolation ON test_cases
	USING (
		organization_id = current_setting('qase.organization_id', true)::uuid
		AND project_id = current_setting('qase.project_id', true)::uuid
	);

COMMIT;
