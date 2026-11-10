-- Qase PostgreSQL migration 045: versioned Founder actions and tenant RLS.
-- Forward-only: preserve the legacy row and previously applied checksums.

ALTER TABLE founder_project_state DROP CONSTRAINT founder_project_state_shape;
ALTER TABLE founder_project_state ADD CONSTRAINT founder_project_state_shape
	CHECK (
		jsonb_typeof(state) = 'object'
		AND pg_column_size(state) <= 1048576
		AND (state->>'schemaVersion')::int <= 2
	);

ALTER TABLE founder_project_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE founder_project_state FORCE ROW LEVEL SECURITY;
CREATE POLICY founder_project_state_tenant_scope ON founder_project_state FOR ALL
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);
