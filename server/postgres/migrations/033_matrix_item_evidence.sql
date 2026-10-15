-- Qase PostgreSQL migration 033
-- #14650 (NI02 Phase 2): per-profile evidence on matrix items — execution
-- level actually used, runner/provider, and artifact references. Additive
-- columns only; existing rows correctly carry NULL (no evidence claimed).

BEGIN;

ALTER TABLE matrix_run_items
	ADD COLUMN IF NOT EXISTS execution_level text,
	ADD COLUMN IF NOT EXISTS execution_provider text,
	ADD COLUMN IF NOT EXISTS artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN matrix_run_items.execution_level IS 'Execution level actually used (SIMULATED/VIRTUAL_DEVICE/REAL_DEVICE) — never the requested one.';
COMMENT ON COLUMN matrix_run_items.artifact_refs IS 'References to session artifacts (screenshot/video) actually captured under this profile; empty = none captured.';

COMMIT;
