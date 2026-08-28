-- Qase PostgreSQL migration 009: durable Founder Mode product reviews.
--
-- Founder reviews are kept separate from QA reports and SQA assessments so
-- historical runs remain unambiguous. The bounded JSON document contains only
-- product context, evidence references, observations, and the generated review.

ALTER TABLE qa_runs
	DROP CONSTRAINT qa_runs_mode_valid,
	DROP CONSTRAINT qa_runs_sqa_shape,
	ADD COLUMN founder_assessment jsonb;

ALTER TABLE qa_runs
	ADD CONSTRAINT qa_runs_mode_valid
		CHECK (run_mode IN ('qa', 'sqa', 'founder')),
	ADD CONSTRAINT qa_runs_founder_assessment_object
		CHECK (
			founder_assessment IS NULL
			OR (
				jsonb_typeof(founder_assessment) = 'object'
				AND pg_column_size(founder_assessment) <= 1048576
			)
		),
	ADD CONSTRAINT qa_runs_mode_shape
		CHECK (
			(
				run_mode = 'qa'
				AND sqa_assessment IS NULL
				AND founder_assessment IS NULL
				AND cardinality(sqa_profiles) = 0
			)
			OR (
				run_mode = 'sqa'
				AND sqa_assessment IS NOT NULL
				AND founder_assessment IS NULL
			)
			OR (
				run_mode = 'founder'
				AND founder_assessment IS NOT NULL
				AND sqa_assessment IS NULL
				AND cardinality(sqa_profiles) = 0
			)
		);
