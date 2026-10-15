-- Qase PostgreSQL migration 035 — QA run scope selection
-- Persists the exact coverage values the user selected in the New QA Run
-- dialog so reports can distinguish selected vs executed coverage.
-- (Carried over from DEV where it was migration 023; renumbered to 035 after
-- the NIHARIKA migration chain 023–034.)
ALTER TABLE qa_runs
	ADD COLUMN IF NOT EXISTS scope_selection jsonb,
	ADD CONSTRAINT qa_runs_scope_selection_values
		CHECK (scope_selection IS NULL OR jsonb_typeof(scope_selection) = 'array');

-- Optional index for analytics on focused vs default sweeps.
CREATE INDEX IF NOT EXISTS qa_runs_scope_selection_active_runs
	ON qa_runs (organization_id, project_id, created_at)
	WHERE scope_selection IS NOT NULL AND deleted_at IS NULL;
