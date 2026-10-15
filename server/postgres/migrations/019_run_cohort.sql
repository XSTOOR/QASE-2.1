-- Qase PostgreSQL migration 019: persist the analytics cohort on qa_runs (Phase 12 launch parity).
-- Nullable; only ever 'pilot' (invite-admitted beta users) or NULL.
-- Forward-only and additive: older server versions ignore the column safely.
ALTER TABLE qa_runs ADD COLUMN cohort text;

-- Optional sanity constraint: allow only the one cohort value we mint.
ALTER TABLE qa_runs ADD CONSTRAINT qa_runs_cohort_check CHECK (cohort IS NULL OR cohort = 'pilot');
