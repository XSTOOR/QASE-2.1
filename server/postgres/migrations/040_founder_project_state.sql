-- Qase PostgreSQL migration 040: project-level Founder Mode state.
--
-- Founder Mode persists its latest per-project state (detected context,
-- goals/constraints, the last successful recommendation set with stable ids
-- and set version, user selections, and handoff status/reference) keyed by
-- the trusted tenant project. Kept separate from qa_runs.drytis_integration,
-- which the CHECK in migration 010 restricts to QA runs.

CREATE TABLE founder_project_state (
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	state jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT founder_project_state_pk PRIMARY KEY (organization_id, project_id),
	CONSTRAINT founder_project_state_shape
		CHECK (
			jsonb_typeof(state) = 'object'
			AND pg_column_size(state) <= 1048576
			AND (state->>'schemaVersion')::int <= 1
		)
);

COMMENT ON TABLE founder_project_state IS 'Latest Founder Mode state per trusted tenant project: context, goals, recommendation set, selections, handoff.';
