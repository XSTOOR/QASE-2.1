-- Qase PostgreSQL migration 027: device runtime (Phase 20).
-- Structured device runtime data: user agents, DPR, touch/input, media and
-- permission capabilities on device models; permission + orientation
-- scenarios and requested execution level on environments; the ACTUAL
-- execution level, provider and observed runtime facts on runs.
-- All additive, all nullable — existing rows keep working unchanged.

ALTER TABLE device_models
	ADD COLUMN user_agent_os text,
	ADD COLUMN dpr real,
	ADD COLUMN touch boolean,
	ADD COLUMN input text,
	ADD COLUMN media_capabilities jsonb,
	ADD COLUMN permission_capabilities jsonb;

ALTER TABLE environments
	ADD COLUMN permission_scenario jsonb,
	ADD COLUMN orientation_scenario text
		CONSTRAINT environments_orientation_scenario_valid CHECK (
			orientation_scenario IS NULL
			OR orientation_scenario IN ('portrait', 'landscape', 'rotate-during-test')
		),
	ADD COLUMN execution_level_requested text
		CONSTRAINT environments_execution_level_requested_valid CHECK (
			execution_level_requested IS NULL
			OR execution_level_requested IN ('REAL_DEVICE', 'VIRTUALIZED', 'SIMULATED')
		);

ALTER TABLE qa_runs
	ADD COLUMN execution_level_actual text
		CONSTRAINT qa_runs_execution_level_actual_valid CHECK (
			execution_level_actual IS NULL
			OR execution_level_actual IN ('REAL_DEVICE', 'VIRTUALIZED', 'SIMULATED')
		),
	ADD COLUMN execution_provider_actual text,
	ADD COLUMN runtime_facts jsonb;
