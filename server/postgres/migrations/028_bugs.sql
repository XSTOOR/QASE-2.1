-- Qase PostgreSQL migration 028: bug reports with BUG-XXXX ids.
--
-- Bugs are auto-associated with the environment (frozen snapshot) and the run
-- that produced them, mirroring the environment_snapshot pattern from
-- migration 015: the snapshot survives catalog edits so a bug report stays an
-- accurate record of what was tested. Optional link to the test case.

BEGIN;

CREATE TABLE IF NOT EXISTS bugs (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	bug_number text NOT NULL,
	title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
	description text,
	severity text NOT NULL DEFAULT 'medium'
		CHECK (severity IN ('low', 'medium', 'high', 'critical')),
	status text NOT NULL DEFAULT 'open'
		CHECK (status IN ('open', 'in_progress', 'resolved', 'wont_fix', 'reopened')),
	category text,
	expected text,
	actual text,
	steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
	environment_id text,
	environment_snapshot jsonb,
	execution_level text,
	linked_run_id uuid,
	linked_test_case_id text,
	evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
	created_by uuid,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT bugs_tenant_fk FOREIGN KEY (organization_id, project_id)
		REFERENCES projects (organization_id, id) ON DELETE CASCADE,
	CONSTRAINT bugs_number_unique UNIQUE (organization_id, project_id, bug_number)
);

CREATE INDEX IF NOT EXISTS bugs_tenant_idx ON bugs (organization_id, project_id);
CREATE INDEX IF NOT EXISTS bugs_status_idx ON bugs (organization_id, project_id, status);
CREATE INDEX IF NOT EXISTS bugs_environment_idx ON bugs (organization_id, project_id, environment_id);

-- RLS mirrors test_cases: tenant-scoped via the qase.* GUCs.
ALTER TABLE bugs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bugs_tenant_isolation ON bugs;
CREATE POLICY bugs_tenant_isolation ON bugs
	USING (
		organization_id = current_setting('qase.organization_id', true)::uuid
		AND project_id = current_setting('qase.project_id', true)::uuid
	)
	WITH CHECK (
		organization_id = current_setting('qase.organization_id', true)::uuid
		AND project_id = current_setting('qase.project_id', true)::uuid
	);

COMMIT;
