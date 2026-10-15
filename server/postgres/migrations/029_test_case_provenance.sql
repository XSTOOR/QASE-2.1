-- Qase PostgreSQL migration 029: test case provenance for agent-generated cases (autogen).
--
-- Adds source tracking: 'manual' (authored in the panel) vs 'auto' (generated
-- by the agent from a completed run), plus the originating run id and target
-- URL. Additive and backward compatible — existing rows default to manual.

BEGIN;

ALTER TABLE test_cases
	ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
		CHECK (source IN ('manual', 'auto')),
	ADD COLUMN IF NOT EXISTS source_run_id text,
	ADD COLUMN IF NOT EXISTS source_url text;

CREATE INDEX IF NOT EXISTS test_cases_source_run_idx
	ON test_cases (organization_id, project_id, source_run_id)
	WHERE deleted = false AND source = 'auto';

COMMIT;
