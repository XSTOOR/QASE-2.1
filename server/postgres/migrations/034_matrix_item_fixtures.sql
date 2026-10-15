-- Qase PostgreSQL migration 034
-- #14650 (NI02 Phase 2): per-profile known-defect fixture verdicts and
-- runtime facts on matrix items. Additive jsonb columns; existing rows keep
-- the defaults (no fixture claims, no facts) — never fabricated.

BEGIN;

ALTER TABLE matrix_run_items
	ADD COLUMN IF NOT EXISTS fixture_verdicts jsonb NOT NULL DEFAULT '[]'::jsonb,
	ADD COLUMN IF NOT EXISTS runtime_facts jsonb;

COMMENT ON COLUMN matrix_run_items.fixture_verdicts IS 'Known-defect fixture verdicts per profile: {fixtureId, expected, reproduced TRUE/FALSE/NOT_VERIFIED, evidence, error}[] — always from actual execution.';
COMMENT ON COLUMN matrix_run_items.runtime_facts IS 'Runtime facts probed from the session browser under this profile (UA/viewport/DPR + honest execution level/provider); NULL when no facts were captured.';

COMMIT;
