-- Qase PostgreSQL migration 021: standard-QA test selection per run.
-- NULL (the default) preserves the historical full-coverage run; a non-empty
-- id array must reference the server catalog (validated at the API boundary).
-- Qase PostgreSQL migration 021


ALTER TABLE qa_runs ADD COLUMN selected_tests text[];

ALTER TABLE qa_runs ADD CONSTRAINT qa_runs_selected_tests_valid
	CHECK (
		selected_tests IS NULL
		OR (array_length(selected_tests, 1) >= 1
			AND array_length(selected_tests, 1) <= 32
			AND array_position(selected_tests, NULL) IS NULL)
	);
