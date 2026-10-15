-- Qase PostgreSQL migration 030 (2027.03.0, #14631 NI01):
-- Stable lowercase profile aliases for environments.
--
-- The ENV ID stays the source of truth for run linking; profile_id is an
-- additive reporting/bookkeeping alias (e.g. iphone17promax-ios26-safari26).
--
-- Deliberately NO SQL backfill: the alias algorithm (device-name token,
-- minor-OS digits kept — server/environmentCatalog.js buildProfileId) cannot
-- be faithfully replicated in SQL, and a slug-segment approximation would
-- collide (ios 18.0/18.3 → ios18) and break a unique index on any populated
-- table. Instead:
--   * the deterministic seed upsert writes profile_id from JS for every
--     catalog environment, and
--   * rowToEnvironment() derives the alias on read for rows persisted before
--     this column existed, so the alias is always present to consumers.

ALTER TABLE environments
	ADD COLUMN profile_id text;

-- Lookup index only — NOT unique. Custom environments may legitimately repeat
-- a builtin combination's identity tuple; a unique index would reject their
-- inserts. Uniqueness within the generated matrix is guaranteed by
-- buildProfileId determinism (asserted in environmentCatalog.test.js), not by
-- the database.
CREATE INDEX environments_profile_id_idx
	ON environments (organization_id, project_id, profile_id)
	WHERE profile_id IS NOT NULL;
