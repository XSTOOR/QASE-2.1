-- Qase PostgreSQL migration 026: cross-platform catalog (Phase 9).
-- The catalog grows from Apple-only to Apple + Android + Windows. These are
-- additive changes only — no existing rows, columns or ids are touched.
--
-- Platform CHECK constraints from migration 016 are replaced so android and
-- windows rows can be stored. (Postgres cannot ALTER a CHECK constraint in
-- place; the pattern is DROP + re-ADD. Constraint names are stable, so this
-- migration is idempotent against any database that ran 016.)

ALTER TABLE device_categories DROP CONSTRAINT device_categories_platform_valid;
ALTER TABLE device_categories ADD CONSTRAINT device_categories_platform_valid
	CHECK (platform IN ('ios', 'ipados', 'macos', 'android', 'windows'));

ALTER TABLE browser_platform_support DROP CONSTRAINT browser_platform_support_platform_valid;
ALTER TABLE browser_platform_support ADD CONSTRAINT browser_platform_support_platform_valid
	CHECK (platform IN ('ios', 'ipados', 'macos', 'android', 'windows'));
