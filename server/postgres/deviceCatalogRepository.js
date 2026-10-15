import { buildCatalogSeed, osVersionId } from '../deviceCatalogSeed.js';

/**
 * PostgreSQL persistence for the global device/OS/browser catalog
 * (migration 016 tables). The catalog is product-wide reference data —
 * no tenant scoping, no RLS (read-only for regular request paths; writes go
 * through admin validation in the service layer).
 *
 * Seeding is idempotent: natural-key upserts, never deletes. Rows an operator
 * added (e.g. a future OS version) are never removed by a re-seed.
 */

// entity -> { table, columns, primaryKey } map for generic list/create/update.
const ENTITIES = {
	deviceCategories: { table: 'device_categories', columns: ['id', 'display_name', 'device_type', 'platform', 'sort_order'], primaryKey: 'id' },
	hardware: { table: 'hardware', columns: ['id', 'display_name', 'vendor', 'sort_order'], primaryKey: 'id' },
	deviceModels: { table: 'device_models', columns: ['id', 'category_id', 'display_name', 'slug', 'browserstack_device_name', 'screen_size', 'screen_resolution', 'is_real_device', 'hardware_id'], primaryKey: 'id' },
	deviceGenerations: { table: 'device_generations', columns: ['id', 'device_model_id', 'label', 'hardware_id', 'sort_order'], primaryKey: 'id' },
	osFamilies: { table: 'os_families', columns: ['id', 'display_name', 'env_code', 'sort_order'], primaryKey: 'id' },
	osVersions: { table: 'os_versions', columns: ['id', 'os_family_id', 'version', 'display', 'major', 'sort_key'], primaryKey: 'id' },
	browsers: { table: 'browsers', columns: ['id', 'display_name', 'env_code', 'independently_versioned', 'sort_order'], primaryKey: 'id' },
	browserVersions: { table: 'browser_versions', columns: ['id', 'browser_id', 'version', 'sort_key'], primaryKey: 'id' },
	deviceOsCompatibility: { table: 'device_os_compatibility', columns: ['device_model_id', 'os_version_id'], primaryKey: ['device_model_id', 'os_version_id'] },
	browserPlatformSupport: { table: 'browser_platform_support', columns: ['browser_id', 'platform', 'supported'], primaryKey: ['browser_id', 'platform'] }
};

function upsertSql(entity, row) {
	const columns = entity.columns;
	const params = columns.map((column) => row[column]);
	const placeholders = params.map((_, index) => `$${index + 1}`).join(', ');
	const conflictKeys = Array.isArray(entity.primaryKey) ? entity.primaryKey.join(', ') : entity.primaryKey;
	const updates = columns
		.filter((column) => !(Array.isArray(entity.primaryKey) ? entity.primaryKey : [entity.primaryKey]).includes(column))
		.map((column) => `${column} = EXCLUDED.${column}`)
		.join(', ');
	return {
		sql: `INSERT INTO ${entity.table} (${columns.join(', ')})
		      VALUES (${placeholders})
		      ON CONFLICT (${conflictKeys}) DO UPDATE SET ${updates}, updated_at = CURRENT_TIMESTAMP`,
		params
	};
}

export function createPostgresDeviceCatalogRepository(pool) {
	/**
	 * Idempotent catalog seed. Upserts every row from the frozen catalog seed;
	 * never deletes operator-added rows.
	 */
	async function seed() {
		const seedData = buildCatalogSeed();
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const order = ['deviceCategories', 'hardware', 'osFamilies', 'osVersions', 'deviceModels', 'deviceGenerations', 'browsers', 'browserVersions', 'deviceOsCompatibility', 'browserPlatformSupport'];
			let inserts = 0;
			for (const name of order) {
				const entity = ENTITIES[name];
				for (const row of seedData[name]) {
					const { sql, params } = upsertSql(entity, row);
					await client.query(sql, params);
					inserts += 1;
				}
			}
			await client.query('COMMIT');
			return { inserted: inserts };
		} catch (error) {
			await client.query('ROLLBACK').catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}

	/** List rows for an entity, optionally filtered by exact-match column values. */
	async function list(entityName, filters = {}) {
		const entity = ENTITIES[entityName];
		if (!entity) throw new Error(`Unknown catalog entity "${entityName}"`);
		const conditions = [];
		const params = [];
		for (const [key, value] of Object.entries(filters)) {
			if (!entity.columns.includes(key)) continue;
			params.push(value);
			conditions.push(`${key} = $${params.length}`);
		}
		const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
		const result = await pool.query(
			`SELECT * FROM ${entity.table} ${where} ORDER BY sort_order NULLS LAST, id`,
			params
		);
		return result.rows;
	}

	/** Create (upsert) a row for an entity. Returns the stored row. */
	async function create(entityName, row) {
		const entity = ENTITIES[entityName];
		if (!entity) throw new Error(`Unknown catalog entity "${entityName}"`);
		if (entityName === 'browserVersions' && !row.id) {
			row = { ...row, id: `${row.browser_id}:${row.version}` };
		}
		if (entityName === 'osVersions' && !row.id) {
			row = { ...row, id: osVersionId(row.os_family_id, row.version) };
		}
		const { sql, params } = upsertSql(entity, row);
		await pool.query(sql, params);
		const key = Array.isArray(entity.primaryKey) ? entity.primaryKey : [entity.primaryKey];
		const stored = await list(entityName, Object.fromEntries(key.map((k) => [k, row[k]])));
		return stored[0] ?? null;
	}

	/**
	 * Data-driven compatibility check: does this device model support this OS
	 * version, and is this browser supported on that platform? Answers come
	 * from catalog rows, not code constants.
	 */
	async function isCombinationSupported({ deviceSlug, platform, osVersion, browserCode, browserVersion }) {
		const deviceResult = await pool.query(
			`SELECT dm.id AS slug, dm.category_id, dc.platform
			   FROM device_models dm JOIN device_categories dc ON dc.id = dm.category_id
			  WHERE dm.slug = $1 LIMIT 1`,
			[deviceSlug]
		);
		if (deviceResult.rows.length === 0) {
			return { ok: false, reason: `Unknown device "${deviceSlug}"` };
		}
		const device = deviceResult.rows[0];
		const effectivePlatform = platform ?? device.platform;

		const versionId = osVersionId(effectivePlatform, osVersion);
		const compatResult = await pool.query(
			`SELECT 1 FROM device_os_compatibility
			  WHERE device_model_id = $1 AND os_version_id = $2 LIMIT 1`,
			[deviceSlug, versionId]
		);
		if (compatResult.rows.length === 0) {
			return { ok: false, reason: `${deviceSlug} does not support ${effectivePlatform} ${osVersion}` };
		}

		const browserResult = await pool.query(
			`SELECT supported FROM browser_platform_support WHERE browser_id = $1 AND platform = $2 LIMIT 1`,
			[browserCode, effectivePlatform]
		);
		if (browserResult.rows.length === 0 || !browserResult.rows[0].supported) {
			return { ok: false, reason: `Browser "${browserCode}" is not available on ${effectivePlatform}` };
		}

		if (browserVersion !== undefined && browserVersion !== null) {
			const browserRow = await pool.query(
				`SELECT independently_versioned FROM browsers WHERE id = $1 LIMIT 1`,
				[browserCode]
			);
			const independentlyVersioned = browserRow.rows[0]?.independently_versioned;
			if (independentlyVersioned) {
				const versionRow = await pool.query(
					`SELECT 1 FROM browser_versions WHERE browser_id = $1 AND version = $2 LIMIT 1`,
					[browserCode, String(browserVersion)]
				);
				if (versionRow.rows.length === 0) {
					return { ok: false, reason: `Browser "${browserCode}" version ${browserVersion} is not in the catalog` };
				}
			}
		}

		return { ok: true };
	}

	return { seed, list, create, isCombinationSupported, ENTITIES };
}
