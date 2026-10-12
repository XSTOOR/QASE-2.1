-- Qase PostgreSQL migration 022: security testing authorization per run.
-- Set when the run's test selection includes a security-category check and the
-- requester explicitly confirmed the target is an authorized, isolated test
-- environment (validated at the API boundary; NULL for standard runs).


ALTER TABLE qa_runs ADD COLUMN security_authorization jsonb;

ALTER TABLE qa_runs ADD CONSTRAINT qa_runs_security_authorization_valid
	CHECK (
		security_authorization IS NULL
		OR (
			NOT (security_authorization ? 'confirmed')
			OR jsonb_typeof(security_authorization -> 'confirmed') = 'boolean'
		)
	);
