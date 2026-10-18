-- Qase PostgreSQL migration 041: feedback testing mode.
--
-- #16656 — persist the testing mode (qa | sqa | founder) on each feedback
-- record so the admin feedback list and analytics can attribute feedback to
-- the mode that produced it. Legacy rows default to 'qa' (the original and
-- by far the most common mode when feedback was introduced).

ALTER TABLE qa_run_feedback
	ADD COLUMN mode text NOT NULL DEFAULT 'qa';

ALTER TABLE qa_run_feedback
	DROP CONSTRAINT IF EXISTS qa_run_feedback_mode_check;

ALTER TABLE qa_run_feedback
	ADD CONSTRAINT qa_run_feedback_mode_check
		CHECK (mode IN ('qa', 'sqa', 'founder'));

COMMENT ON COLUMN qa_run_feedback.mode IS 'Testing mode of the run the feedback was submitted for: qa | sqa | founder (legacy rows default qa).';
