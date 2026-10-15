-- Qase PostgreSQL migration 018: engine and device emulation parity for QA runs.
--
-- Multi-engine and device-emulation parity for the Postgres run store.
--
-- The local JSON store has persisted `engine`, `device` and
-- `deviceLandscape` on sessions since the multi-browser feature landed;
-- the Postgres repository silently dropped them, so after a restart every
-- hydrated run degraded to chromium/desktop/portrait — losing engine-tagged
-- findings (qaTools), engine-suffixed titles (app), cross-engine prompt
-- guidance, and landscape PDF layout (reportPdf).
--
-- Backfills are safe: existing rows ran under the historical defaults.

ALTER TABLE qa_runs ADD COLUMN engine text NOT NULL DEFAULT 'chromium';
ALTER TABLE qa_runs ADD COLUMN device text NOT NULL DEFAULT 'desktop';
ALTER TABLE qa_runs ADD COLUMN device_landscape boolean NOT NULL DEFAULT false;
