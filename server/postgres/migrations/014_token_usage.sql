-- Qase PostgreSQL migration 014
-- Token usage recorded after each run: provider-reported or estimated totals
-- kept on the run row, mirroring context_usage.
ALTER TABLE qa_runs ADD COLUMN IF NOT EXISTS token_usage jsonb;

ALTER TABLE qa_runs DROP CONSTRAINT IF EXISTS qa_runs_token_usage_object;
ALTER TABLE qa_runs ADD CONSTRAINT qa_runs_token_usage_object
	CHECK (token_usage IS NULL OR jsonb_typeof(token_usage) = 'object');
