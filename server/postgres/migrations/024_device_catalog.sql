-- Qase PostgreSQL migration 024: DB-backed device / OS / browser catalog.
--
-- Replaces the code-frozen catalog (server/environmentCatalog.js) as the runtime
-- source of truth. The frozen module remains the seed source for fresh installs.
-- The catalog is GLOBAL product reference data (shared across tenants) — like a
-- compatibility matrix, not per-tenant rows. Environments (tenant-scoped, 015)
-- gain FK references plus screen_resolution / orientation columns.
--
-- Hierarchy: DeviceCategory → DeviceModel → DeviceGeneration → Hardware
--            OsFamily → OsVersion; Browser → BrowserVersion + platform support.
-- Compatibility: device_os_compatibility (model × OS version) and
--            browser_platform_support (browser × platform) are data rows, so
--            adding a new device/chip/OS version/browser version is a data
--            change, not a code change.

-- ---------------------------------------------------------------------------
-- Device side
-- ---------------------------------------------------------------------------

CREATE TABLE device_categories (
	id text PRIMARY KEY,                       -- 'iphone' | 'ipad' | 'mac'
	display_name text NOT NULL,
	device_type text NOT NULL,                 -- mobile | tablet | desktop
	platform text NOT NULL,                    -- ios | ipados | macos
	sort_order integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT device_categories_device_type_valid CHECK (device_type IN ('mobile', 'tablet', 'desktop')),
	CONSTRAINT device_categories_platform_valid CHECK (platform IN ('ios', 'ipados', 'macos'))
);

CREATE TABLE hardware (
	id text PRIMARY KEY,                       -- 'm1' … 'm5', 'a14' … 'a19'
	display_name text NOT NULL,                -- 'Apple M3'
	vendor text NOT NULL DEFAULT 'Apple',
	sort_order integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE device_models (
	id text PRIMARY KEY,                       -- natural key: the ENV-ID slug (IP16PRO)
	category_id text NOT NULL REFERENCES device_categories (id),
	display_name text NOT NULL,                -- 'iPhone 16 Pro'
	slug text NOT NULL,                        -- 'IP16PRO' (ENV-ID slug)
	browserstack_device_name text,
	screen_size text,                          -- '6.3 inch'
	screen_resolution text,                    -- '1179×2556' physical px (informational)
	is_real_device boolean NOT NULL DEFAULT true,
	hardware_id text REFERENCES hardware (id),
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT device_models_slug_unique UNIQUE (slug)
);

CREATE INDEX device_models_category_idx ON device_models (category_id);
CREATE INDEX device_models_display_name_idx ON device_models (display_name);

CREATE TABLE device_generations (
	id uuid PRIMARY KEY,
	device_model_id text NOT NULL REFERENCES device_models (id) ON DELETE CASCADE,
	label text NOT NULL,                       -- 'M3', '3rd gen', '2024'
	hardware_id text REFERENCES hardware (id),
	sort_order integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT device_generations_unique UNIQUE (device_model_id, label)
);

-- ---------------------------------------------------------------------------
-- OS side
-- ---------------------------------------------------------------------------

CREATE TABLE os_families (
	id text PRIMARY KEY,                       -- 'ios' | 'ipados' | 'macos'
	display_name text NOT NULL,                -- 'iOS'
	env_code text NOT NULL,                    -- 'IOS' | 'IPADOS' | 'MAC'
	sort_order integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE os_versions (
	id text PRIMARY KEY,                       -- natural key: 'ios:18.3' / 'macos:Sonoma'
	os_family_id text NOT NULL REFERENCES os_families (id),
	version text NOT NULL,                     -- '18.3' (ios/ipados) | 'Sonoma' (macos)
	display text NOT NULL,                     -- 'iOS 18.3'
	major text NOT NULL,                       -- '18' | '26'
	sort_key text NOT NULL,                    -- zero-padded sortable: '018.003'
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT os_versions_family_version_unique UNIQUE (os_family_id, version)
);

CREATE INDEX os_versions_family_idx ON os_versions (os_family_id);

-- Device × OS compatibility (data-driven; replaces frozen per-device osVersions lists)
CREATE TABLE device_os_compatibility (
	device_model_id text NOT NULL REFERENCES device_models (id) ON DELETE CASCADE,
	os_version_id text NOT NULL REFERENCES os_versions (id) ON DELETE CASCADE,
	PRIMARY KEY (device_model_id, os_version_id)
);

CREATE INDEX device_os_compat_os_idx ON device_os_compatibility (os_version_id);

-- ---------------------------------------------------------------------------
-- Browser side
-- ---------------------------------------------------------------------------

CREATE TABLE browsers (
	id text PRIMARY KEY,                       -- 'safari' | 'chrome' …
	display_name text NOT NULL,
	env_code text NOT NULL,                    -- 'SAF' | 'CHR' …
	independently_versioned boolean NOT NULL DEFAULT true,
	sort_order integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE browser_versions (
	id text PRIMARY KEY,                       -- natural key: 'chrome:153'
	browser_id text NOT NULL REFERENCES browsers (id) ON DELETE CASCADE,
	version text NOT NULL,                     -- '153'
	sort_key text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT browser_versions_unique UNIQUE (browser_id, version)
);

CREATE INDEX browser_versions_browser_idx ON browser_versions (browser_id);

CREATE TABLE browser_platform_support (
	browser_id text NOT NULL REFERENCES browsers (id) ON DELETE CASCADE,
	platform text NOT NULL,                    -- ios | ipados | macos
	supported boolean NOT NULL DEFAULT false,
	PRIMARY KEY (browser_id, platform),
	CONSTRAINT browser_platform_support_platform_valid CHECK (platform IN ('ios', 'ipados', 'macos'))
);

-- ---------------------------------------------------------------------------
-- Environments extension (tenant-scoped table from migration 015)
-- ---------------------------------------------------------------------------

ALTER TABLE environments
	ADD COLUMN screen_resolution text,
	ADD COLUMN orientation text
		CONSTRAINT environments_orientation_valid CHECK (orientation IN ('portrait', 'landscape')),
	ADD COLUMN description text;

-- Link existing environments to the catalog. The device string in 015 rows
-- matches device_models.display_name exactly (the catalog is its seed source).
ALTER TABLE environments
	ADD COLUMN device_model_slug text;

UPDATE environments
	SET device_model_slug = device_models.slug
	FROM device_models
	WHERE environments.device = device_models.display_name;

ALTER TABLE environments
	ADD CONSTRAINT environments_device_model_fk
	FOREIGN KEY (device_model_slug) REFERENCES device_models (slug);

CREATE INDEX environments_device_model_slug_idx ON environments (device_model_slug);

