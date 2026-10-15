-- Qase PostgreSQL migration 036 — matrix item retry ledger
-- #14937 Phase 3: persist the bounded per-item retry ledger.
-- retryCount is monotonic across orchestrator restarts (the in-memory counter
-- used before vanished on container replacement, allowing unlimited retries).

ALTER TABLE matrix_run_items
	ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;
