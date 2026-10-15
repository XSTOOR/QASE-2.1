-- Qase PostgreSQL migration 032
-- #14633 (NI02 Phase 1): durable matrix-run linkage on sessions. The matrix
-- orchestrator spawns one session per device/browser profile; qa_runs gets an
-- additive matrix_run_id column so the link survives restarts and can be
-- traced from both sides. Additive only — no backfill (existing runs predate
-- the matrix engine and correctly carry NULL).

ALTER TABLE qa_runs
	ADD COLUMN IF NOT EXISTS matrix_run_id text;

COMMENT ON COLUMN qa_runs.matrix_run_id IS 'Matrix run id (matrix-*) that spawned this session; NULL for standalone runs.';
