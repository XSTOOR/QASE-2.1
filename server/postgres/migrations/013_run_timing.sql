-- Qase PostgreSQL migration 013: run execution timing.
-- Server-authoritative timing fields for the Test Execution Timer.
-- started_at / completed_at already exist (002); these add phase breakdown
-- columns. All nullable: legacy rows keep NULL until their next state write.

ALTER TABLE qa_runs ADD COLUMN queued_at timestamptz;
ALTER TABLE qa_runs ADD COLUMN setup_started_at timestamptz;
ALTER TABLE qa_runs ADD COLUMN setup_ended_at timestamptz;
ALTER TABLE qa_runs ADD COLUMN report_started_at timestamptz;
ALTER TABLE qa_runs ADD COLUMN report_ended_at timestamptz;
ALTER TABLE qa_runs ADD COLUMN cancelled_at timestamptz;
ALTER TABLE qa_runs ADD COLUMN failure_reason text;

-- Conservative backfill: terminal runs that had a start but no completion
-- timestamp get one from their last update, so historic durations exist.
UPDATE qa_runs SET completed_at = updated_at
WHERE completed_at IS NULL AND started_at IS NOT NULL
	AND status IN ('done', 'error', 'interrupted');

CREATE INDEX qa_runs_project_timing
	ON qa_runs (organization_id, project_id, status, started_at)
	WHERE deleted_at IS NULL AND started_at IS NOT NULL;
