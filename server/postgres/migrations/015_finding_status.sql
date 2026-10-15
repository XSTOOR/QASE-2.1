-- Qase PostgreSQL migration 015
-- Finding lifecycle tracking: status + note + timestamp, defaulting to open.
ALTER TABLE qa_findings ADD COLUMN IF NOT EXISTS status text;
UPDATE qa_findings SET status = 'open' WHERE status IS NULL;
ALTER TABLE qa_findings ALTER COLUMN status SET NOT NULL;
ALTER TABLE qa_findings DROP CONSTRAINT IF EXISTS qa_findings_status_enum;
ALTER TABLE qa_findings ADD CONSTRAINT qa_findings_status_enum
	CHECK (status IN ('open', 'in_progress', 'fixed', 'wont_fix'));
ALTER TABLE qa_findings ADD COLUMN IF NOT EXISTS status_note text;
ALTER TABLE qa_findings DROP CONSTRAINT IF EXISTS qa_findings_status_note_size;
ALTER TABLE qa_findings ADD CONSTRAINT qa_findings_status_note_size
	CHECK (status_note IS NULL OR length(btrim(status_note)) <= 500);
ALTER TABLE qa_findings ADD COLUMN IF NOT EXISTS status_at bigint;
ALTER TABLE qa_findings DROP CONSTRAINT IF EXISTS qa_findings_status_at_positive;
ALTER TABLE qa_findings ADD CONSTRAINT qa_findings_status_at_positive
	CHECK (status_at IS NULL OR status_at >= 0);
CREATE INDEX IF NOT EXISTS qa_findings_status_idx
	ON qa_findings (organization_id, project_id, run_id, status);
