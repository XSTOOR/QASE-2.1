import { randomUUID } from 'node:crypto';
import {
	generateEnvironments,
	ENVIRONMENT_CATALOG_VERSION
} from '../environmentCatalog.js';
import {
	normalizeEnvironmentInput,
	EnvironmentValidationError,
	EnvironmentConflictError
} from '../environmentService.js';

// The normalizer is shared with the local store backend — a single validation
// path (frozen catalog fallback, DB-backed catalog when attached) for both stores.
export { normalizeEnvironmentInput, EnvironmentValidationError };
void EnvironmentConflictError;

/**
 * PostgreSQL persistence for Apple compatibility environments.
 *
 * The matrix is generated deterministically from the frozen catalog
 * (server/environmentCatalog.js) and upserted by env_id — re-seeding is
 * idempotent, never deletes rows, and never flips `active` back to true on its
 * own, so operator deprecations survive catalog refreshes.
 */

const ENV_COLUMNS = [
	'platform', 'platform_label', 'device', 'os', 'os_version', 'browser',
	'browser_code', 'browser_version', 'device_type', 'screen_size',
	'screen_resolution', 'orientation', 'description',
	'execution_provider', 'is_real_device', 'active', 'browserstack_capabilities',
	'permission_scenario', 'orientation_scenario', 'execution_level_requested',
	'profile_id'
];

export { EnvironmentConflictError };

// camelCase environment record -> snake_case DB columns. #14631: the seed and
// create paths previously indexed camelCase records by snake_case column names,
// silently writing NULLs for every mapped column (masked on read by the frozen
// catalog fallback). One authoritative mapping for all write paths.
const COLUMN_TO_FIELD = {
	platform: 'platform',
	platform_label: 'platformLabel',
	device: 'device',
	os: 'os',
	os_version: 'osVersion',
	browser: 'browser',
	browser_code: 'browserCode',
	browser_version: 'browserVersion',
	device_type: 'deviceType',
	screen_size: 'screenSize',
	screen_resolution: 'screenResolution',
	orientation: 'orientation',
	description: 'description',
	execution_provider: 'executionProvider',
	is_real_device: 'isRealDevice',
	active: 'active',
	browserstack_capabilities: 'runtimeCapabilities',
	permission_scenario: 'permissionScenario',
	orientation_scenario: 'orientationScenario',
	execution_level_requested: 'executionLevelRequested',
	profile_id: 'profileId'
};

/** Column value for an environment record (camelCase source of truth). */
function columnValue(column, record) {
	if (!record) return null;
	const value = record[COLUMN_TO_FIELD[column] ?? column];
	return value === undefined ? null : value;
}

function requireTenant(tenant) {
	if (!tenant || typeof tenant !== 'object') {
		throw new TypeError('Environment storage requires a tenant context.');
	}
	if (!tenant.organizationId || !tenant.projectId) {
		throw new TypeError('Environment tenant context is missing organizationId/projectId.');
	}
	return tenant;
}

function capabilitiesFor(device, platformId, osVersion, browser, browserVersion) {
	if (platformId === 'macos') {
		return {
			browserName: browser.code,
			browserVersion: String(browserVersion),
			os: 'OS X',
			osVersion
		};
	}
	return {
		browserName: browser.code,
		...(browser.code === 'safari' ? {} : { browserVersion: String(browserVersion) }),
		os: 'ios',
		osVersion,
		deviceName: device.browserstackDeviceName,
		realMobile: true
	};
}

export function createPostgresEnvironmentRepository(pool, options = {}) {
	const tenantContext = options.tenantContext;
	const catalogValidator = options.catalogBackend ?? null;
	const effectiveTenant = () => requireTenant(tenantContext);

	async function withTenant(client, tenant) {
		const resolved = requireTenant(tenant);
		await client.query("SELECT set_config('qase.organization_id', $1, true)", [resolved.organizationId]);
		await client.query("SELECT set_config('qase.project_id', $1, true)", [resolved.projectId]);
	}

	/**
	 * Idempotently seed the deterministic matrix. Upsert by env_id; descriptive
	 * fields are refreshed, but `active` is intentionally NOT overwritten — an
	 * environment an operator deactivated stays deactivated. Rows no longer in
	 * the catalog are never deleted (history references them).
	 */
	async function seed(tenant) {
		const resolved = requireTenant(tenant ?? tenantContext);
		const environments = generateEnvironments();
		// #14275 (Phase 2): registry-sourced seed — builtin rows first, then
		// connected provider overlays (additive, PROV- namespaced envIds).
		// Registry failure never blocks seeding: builtin stays authoritative.
		let providerRows = [];
		try {
			const { mergeCatalog, registeredCatalogProviders } = await import('../catalogProviderRegistry.js');
			const slugs = registeredCatalogProviders()
				.filter((provider) => provider.connected !== false)
				.map((provider) => provider.slug);
			const merged = await mergeCatalog(['builtin', ...slugs]);
			providerRows = merged.environments.filter((env) => String(env.envId).startsWith('PROV-'));
		} catch {
			providerRows = [];
		}
		const refreshed = ENV_COLUMNS.filter((column) => column !== 'active');
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await withTenant(client, resolved);
			for (const env of environments) {
				const params = [randomUUID(), resolved.organizationId, resolved.projectId, env.envId];
				for (const column of ENV_COLUMNS) {
					const value = columnValue(column, env);
					params.push(column === 'browserstack_capabilities' || column === 'permission_scenario'
						? (value === null ? null : JSON.stringify(value))
						: value);
				}
				const placeholders = params.map((_, index) => `$${index + 1}`).join(', ');
				const updates = refreshed.map((column) => `${column} = EXCLUDED.${column}`).join(', ');
				await client.query(
					`INSERT INTO environments (id, organization_id, project_id, env_id, ${ENV_COLUMNS.join(', ')})
					 VALUES (${placeholders})
					 ON CONFLICT (organization_id, project_id, env_id) DO UPDATE SET
						${updates}, updated_at = CURRENT_TIMESTAMP`,
					params
				);
			}
			// Provider overlay rows: idempotent upsert preserving active/id —
			// same honesty contract as refreshCatalog's upsertProviderRow.
			for (const env of providerRows) {
				const existing = await client.query(
					'SELECT id, active FROM environments WHERE env_id = $1 LIMIT 1',
					[env.envId]
				);
				const preservedId = existing.rows[0]?.id ?? randomUUID();
				const preservedActive = existing.rows.length > 0 ? existing.rows[0].active : true;
				const params = [preservedId, resolved.organizationId, resolved.projectId, env.envId, preservedActive];
				for (const column of ENV_COLUMNS) {
					if (column === 'active') continue;
					const value = columnValue(column, env);
					params.push(column === 'browserstack_capabilities' || column === 'permission_scenario'
						? (value === null ? null : JSON.stringify(value))
						: value);
				}
				const placeholders = params.map((_, index) => `$${index + 1}`).join(', ');
				const updates = refreshed.map((column) => `${column} = EXCLUDED.${column}`).join(', ');
				await client.query(
					`INSERT INTO environments (id, organization_id, project_id, env_id, active, ${refreshed.join(', ')})
					 VALUES (${placeholders})
					 ON CONFLICT (organization_id, project_id, env_id) DO UPDATE SET
						${updates}, updated_at = CURRENT_TIMESTAMP`,
					params
				);
			}
			// 2027.01.0 (#14273): retire rows that dropped out of the catalog
			// (e.g. macOS pseudo-devices replaced by hardware models).
			// Never delete — history references them; mark inactive so lists
			// with active=true stop offering them. #14275: provider rows
			// (PROV-) are NEVER retired by a builtin-only refresh — they keep
			// last-known state until their own provider updates or drops them.
			await client.query(
				`UPDATE environments
				 SET active = FALSE, updated_at = CURRENT_TIMESTAMP
				 WHERE organization_id = $1 AND project_id = $2
				 AND active = TRUE
				 AND env_id NOT LIKE 'PROV-%'
				 AND env_id <> ALL($3::text[])`,
				[resolved.organizationId, resolved.projectId, environments.map((env) => env.envId)]
			);
			await client.query('COMMIT');
			return { inserted: environments.length + providerRows.length, providerRows: providerRows.length, catalogVersion: ENVIRONMENT_CATALOG_VERSION };
		} catch (error) {
			await client.query('ROLLBACK').catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}

	async function list(tenant, filters = {}) {
		const resolved = requireTenant(tenant ?? tenantContext);
		const client = await pool.connect();
		try {
			await withTenant(client, resolved);
			return await queryFiltered(client, filters, false);
		} finally {
			client.release();
		}
	}

	async function count(tenant, filters = {}) {
		const resolved = requireTenant(tenant ?? tenantContext);
		const client = await pool.connect();
		try {
			await withTenant(client, resolved);
			return await queryFiltered(client, filters, true);
		} finally {
			client.release();
		}
	}

	async function get(tenant, envId) {
		const resolved = requireTenant(tenant ?? tenantContext);
		const client = await pool.connect();
		try {
			await withTenant(client, resolved);
			const result = await client.query(
				'SELECT * FROM environments WHERE env_id = $1 LIMIT 1',
				[envId]
			);
			return result.rows[0] ?? null;
		} finally {
			client.release();
		}
	}

	async function create(tenant, input) {
		const resolved = requireTenant(tenant ?? tenantContext);
		const record = await normalizeEnvironmentInput(input, { catalogBackend: catalogValidator });
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await withTenant(client, resolved);
			const existing = await client.query(
				'SELECT env_id FROM environments WHERE env_id = $1 LIMIT 1',
				[record.envId]
			);
			if (existing.rows.length > 0) {
				await client.query('ROLLBACK');
				throw new EnvironmentConflictError(record.envId);
			}
			const params = [randomUUID(), resolved.organizationId, resolved.projectId, record.envId];
			for (const column of ENV_COLUMNS) {
				const value = columnValue(column, record);
				params.push(column === 'browserstack_capabilities' || column === 'permission_scenario'
					? (value === null ? null : JSON.stringify(value))
					: value);
			}
			const placeholders = params.map((_, index) => `$${index + 1}`).join(', ');
			const result = await client.query(
				`INSERT INTO environments (id, organization_id, project_id, env_id, ${ENV_COLUMNS.join(', ')})
				 VALUES (${placeholders}) RETURNING *`,
				params
			);
			await client.query('COMMIT');
			return result.rows[0];
		} catch (error) {
			await client.query('ROLLBACK').catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}

		/** Patchable fields only: active, execution_provider, scenarios. env_id is immutable. */
		async function update(tenant, envId, patch) {
			const resolved = requireTenant(tenant ?? tenantContext);
			const columnMap = {
				active: 'active',
				executionProvider: 'execution_provider',
				screenResolution: 'screen_resolution',
				orientation: 'orientation',
				description: 'description',
				permissionScenario: 'permission_scenario',
				orientationScenario: 'orientation_scenario',
				executionLevelRequested: 'execution_level_requested'
			};
		const columns = [];
		const params = [];
			for (const [key, value] of Object.entries(patch ?? {})) {
				const column = columnMap[key];
				if (!column) continue;
				columns.push(`${column} = $${params.length + 1}`);
				params.push(column === 'permission_scenario' && value !== null && value !== undefined
					? JSON.stringify(value)
					: (value === undefined ? null : value));
			}
		if (columns.length === 0) return get(tenant, envId);
		params.push(envId);
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await withTenant(client, resolved);
			const result = await client.query(
				`UPDATE environments SET ${columns.join(', ')}, updated_at = CURRENT_TIMESTAMP
				 WHERE env_id = $${params.length} RETURNING *`,
				params
			);
			await client.query('COMMIT');
			return result.rows[0] ?? null;
		} catch (error) {
			await client.query('ROLLBACK').catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}

	async function remove(tenant, envId) {
		const resolved = requireTenant(tenant ?? tenantContext);
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await withTenant(client, resolved);
			const result = await client.query('DELETE FROM environments WHERE env_id = $1', [envId]);
			await client.query('COMMIT');
			return (result.rowCount ?? 0) > 0;
		} catch (error) {
			await client.query('ROLLBACK').catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}

	/**
	 * #14275 (Phase 2): upsert one provider-scoped row (envId must start with
	 * `PROV-`). Idempotent: descriptive fields refresh, but `active` and the
	 * surrogate `id` are preserved — provider refreshes never toggle operator
	 * decisions. Builtin rows are never passed here (guarded).
	 */
	async function upsertProviderRow(tenant, row) {
		if (!row || typeof row.envId !== 'string' || !row.envId.startsWith('PROV-')) {
			throw new EnvironmentValidationError('provider rows must use PROV- namespaced envIds');
		}
		const resolved = requireTenant(tenant ?? tenantContext);
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await withTenant(client, resolved);
			const existing = await client.query(
				'SELECT id, active FROM environments WHERE env_id = $1 LIMIT 1',
				[row.envId]
			);
			const preservedId = existing.rows[0]?.id ?? randomUUID();
			const preservedActive = existing.rows.length > 0 ? existing.rows[0].active : true;
			const params = [preservedId, resolved.organizationId, resolved.projectId, row.envId, preservedActive];
			for (const column of ENV_COLUMNS) {
				if (column === 'active') continue; // preserved above, never provider-set
				const value = columnValue(column, row);
				params.push(column === 'browserstack_capabilities' || column === 'permission_scenario'
					? (value === null ? null : JSON.stringify(value))
					: value);
			}
			const placeholders = params.map((_, index) => `$${index + 1}`).join(', ');
			const refreshed = ENV_COLUMNS.filter((column) => column !== 'active');
			const updates = refreshed.map((column) => `${column} = EXCLUDED.${column}`).join(', ');
			const result = await client.query(
				`INSERT INTO environments (id, organization_id, project_id, env_id, active, ${ENV_COLUMNS.filter((c) => c !== 'active').join(', ')})
				 VALUES (${placeholders})
				 ON CONFLICT (organization_id, project_id, env_id) DO UPDATE SET
					${updates}, updated_at = CURRENT_TIMESTAMP
				 RETURNING *`,
				params
			);
			await client.query('COMMIT');
			return result.rows[0];
		} catch (error) {
			await client.query('ROLLBACK').catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}

	async function queryFiltered(client, filters, countOnly) {
		const conditions = [];
		const params = [];
		const add = (column, value) => {
			params.push(value);
			conditions.push(`${column} = $${params.length}`);
		};
		if (filters.platform) add('platform', filters.platform);
		if (filters.platformGroup?.length) {
			params.push(filters.platformGroup);
			conditions.push(`platform = ANY($${params.length})`);
		}
		if (filters.device) add('device', filters.device);
		if (filters.os) add('os', filters.os);
		if (filters.osVersion) add('os_version', filters.osVersion);
		if (filters.browser) add('browser', filters.browser);
		if (filters.browserCode) add('browser_code', filters.browserCode);
		if (filters.browserVersion) add('browser_version', filters.browserVersion);
		if (filters.deviceType) add('device_type', filters.deviceType);
		if (filters.executionProvider) add('execution_provider', filters.executionProvider);
		if (filters.orientationScenario) add('orientation_scenario', filters.orientationScenario);
		if (filters.executionLevelRequested) add('execution_level_requested', filters.executionLevelRequested);
		if (filters.isRealDevice !== undefined && filters.isRealDevice !== null && filters.isRealDevice !== '') {
			add('is_real_device', filters.isRealDevice === true || filters.isRealDevice === 'true');
		}
		if (filters.active !== undefined && filters.active !== null && filters.active !== '') {
			add('active', filters.active === true || filters.active === 'true');
		}
		if (filters.search) {
			params.push(`%${filters.search}%`);
			conditions.push(`(env_id ILIKE $${params.length} OR device ILIKE $${params.length} OR browser ILIKE $${params.length})`);
		}
		const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
		if (countOnly) {
			const result = await client.query(`SELECT COUNT(*)::int AS count FROM environments ${where}`, params);
			return result.rows[0].count;
		}
		const limit = Number(filters.limit ?? 500);
		const offset = Number(filters.offset ?? 0);
		const result = await client.query(
			`SELECT * FROM environments ${where}
			 ORDER BY platform, device, os_version, browser, browser_version
			 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
			[...params, Math.min(Math.max(limit, 1), 80000), Math.max(offset, 0)]
		);
		return result.rows;
	}

	return { seed, list, count, get, create, update, remove, upsertProviderRow };
}
