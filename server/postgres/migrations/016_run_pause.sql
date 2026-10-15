-- Qase PostgreSQL migration 016: timer pause tracking.
-- Stop = pause: elapsed execution time excludes paused intervals, and a
-- stopped run is Paused, not Cancelled.
-- (Renumbered from 014 on DEV: DEV already has 014_token_usage / 015_finding_status.)

ALTER TABLE qa_runs ADD COLUMN paused_at timestamptz;
ALTER TABLE qa_runs ADD COLUMN paused_seconds double precision NOT NULL DEFAULT 0;

-- Backfill: runs previously stopped by the user were recorded as cancelled.
-- Reclassify them as paused-with-completion so history stays truthful about
-- active execution time: their duration already excluded nothing, so count
-- the stop interval as paused time when the run later resumed, otherwise
-- leave completed_at as the effective end.
UPDATE qa_runs SET paused_seconds = 0
WHERE cancelled_at IS NOT NULL;
