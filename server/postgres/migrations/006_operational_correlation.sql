-- Qase PostgreSQL migration 006: correlate API requests with durable worker jobs.

ALTER TABLE qa_execution_jobs ADD COLUMN correlation_id uuid;
