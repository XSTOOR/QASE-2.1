-- Qase PostgreSQL migration 042: optional hybrid QA persistence.
-- Authored only; apply through the normal
-- reviewed deployment migration process before enabling hybrid runs.
ALTER TABLE qa_runs ADD COLUMN IF NOT EXISTS hybrid_qa jsonb;
ALTER TABLE qa_runs ADD CONSTRAINT qa_runs_hybrid_qa_size
  CHECK (hybrid_qa IS NULL OR octet_length(hybrid_qa::text) <= 4500000);
COMMENT ON COLUMN qa_runs.hybrid_qa IS
  'Versioned QA execution strategy, scenario/evidence ledger and routing telemetry. No provider credentials.';
