-- Qase PostgreSQL migration 017: user feedback on test runs.
-- One feedback record per run per user, kept outside the run aggregate so a
-- submission never touches run data, reports or timing. RLS mirrors qa_runs.

CREATE TABLE qa_run_feedback (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	run_id uuid NOT NULL,
	submitted_by_user_id uuid,
	target_url text,
	run_status text,
	duration_seconds double precision,
	rating integer NOT NULL,
	category text NOT NULL,
	comments text NOT NULL DEFAULT '',
	improvement text,
	status text NOT NULL DEFAULT 'new',
	submitted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT qa_run_feedback_run_fk
		FOREIGN KEY (organization_id, project_id, run_id)
		REFERENCES qa_runs (organization_id, project_id, id) ON DELETE CASCADE,
	CONSTRAINT qa_run_feedback_rating_valid CHECK (rating BETWEEN 1 AND 5),
	CONSTRAINT qa_run_feedback_category_valid CHECK (category IN (
		'test_accuracy', 'test_coverage', 'execution_speed', 'results',
		'ui_ux', 'automation_quality', 'error_handling', 'ease_of_use',
		'overall', 'other'
	)),
	CONSTRAINT qa_run_feedback_status_valid CHECK (status IN (
		'new', 'reviewed', 'in_progress', 'resolved', 'closed'
	)),
	CONSTRAINT qa_run_feedback_comments_size CHECK (char_length(comments) BETWEEN 0 AND 4000),
	CONSTRAINT qa_run_feedback_improvement_size CHECK (improvement IS NULL OR char_length(improvement) <= 4000),
	CONSTRAINT qa_run_feedback_run_submitter_unique UNIQUE (organization_id, project_id, run_id, submitted_by_user_id)
);

CREATE INDEX qa_run_feedback_run_idx ON qa_run_feedback (organization_id, project_id, run_id);
CREATE INDEX qa_run_feedback_submitted_at_idx ON qa_run_feedback (submitted_at DESC);

ALTER TABLE qa_run_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa_run_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY qa_run_feedback_tenant_scope ON qa_run_feedback
	FOR ALL
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);
