-- Qase PostgreSQL migration 008: durable Software Quality Assurance assessments.
--
-- The SQA payload contains Qase-authored control results and evidence references.
-- It must never contain licensed standards text, credentials, cookies, or raw
-- browser artifacts. Those remain in their purpose-built stores.

ALTER TABLE qa_runs
	ADD COLUMN run_mode text NOT NULL DEFAULT 'qa',
	ADD COLUMN sqa_profiles text[] NOT NULL DEFAULT ARRAY[]::text[],
	ADD COLUMN sqa_assessment jsonb;

ALTER TABLE qa_runs
	ADD CONSTRAINT qa_runs_mode_valid
		CHECK (run_mode IN ('qa', 'sqa')),
	ADD CONSTRAINT qa_runs_sqa_profiles_valid
		CHECK (
			array_position(sqa_profiles, NULL) IS NULL
			AND cardinality(sqa_profiles) <= 16
		),
	ADD CONSTRAINT qa_runs_sqa_assessment_object
		CHECK (
			sqa_assessment IS NULL
			OR (
				jsonb_typeof(sqa_assessment) = 'object'
				AND pg_column_size(sqa_assessment) <= 1048576
			)
		),
	ADD CONSTRAINT qa_runs_sqa_shape
		CHECK (
			(run_mode = 'qa' AND sqa_assessment IS NULL AND cardinality(sqa_profiles) = 0)
			OR run_mode = 'sqa'
		);

CREATE INDEX qa_runs_project_mode_recent
	ON qa_runs (organization_id, project_id, run_mode, updated_at DESC, id)
	WHERE deleted_at IS NULL;
