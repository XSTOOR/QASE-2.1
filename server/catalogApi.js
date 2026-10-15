import { EnvironmentValidationError } from './environmentService.js';
import { BROWSERS } from './environmentCatalog.js';

/** Frozen catalog per-platform browser availability, keyed by browser id. */
const BROWSER_PLATFORMS = Object.fromEntries(BROWSERS.map((b) => [b.code ?? b.id, b.platforms ?? null]));

/**
 * REST surface for the DB-backed device/OS/browser catalog (Phase 2 of the
 * Apple device matrix). The catalog is global reference data; reads are open,
 * writes are validated per entity. Everything here is data-driven — adding a
 * new device, OS version or browser version through these endpoints requires
 * no application code change.
 *
 * Mounted by server/app.js as /api/catalog.
 */

export class CatalogValidationError extends Error {
	constructor(message) {
		super(message);
		this.name = 'CatalogValidationError';
		this.code = 'QASE_CATALOG_INVALID';
	}
}

export class CatalogConflictError extends Error {
	constructor(message, detail = {}) {
		super(message);
		this.name = 'CatalogConflictError';
		this.code = 'QASE_CATALOG_CONFLICT';
		this.detail = detail;
	}
}

const ENTITIES = [
	'deviceCategories', 'hardware', 'deviceModels', 'deviceGenerations',
	'osFamilies', 'osVersions', 'browsers', 'browserVersions',
	'deviceOsCompatibility', 'browserPlatformSupport'
];

const PLATFORM_IDS = ['ios', 'ipados', 'macos', 'android', 'windows'];

// Reference rows (id = natural key given by the caller): upsert semantics.
const UPSERT_ENTITIES = new Set(['deviceCategories', 'osFamilies', 'browsers', 'hardware', 'browserPlatformSupport']);

/** Per-entity required fields + value checks for POST bodies. */
function validateCreatePayload(entity, body) {
	const required = {
		deviceCategories: ['id', 'display_name', 'device_type'],
		hardware: ['id', 'display_name'],
		deviceModels: ['display_name', 'category_id'],
		deviceGenerations: ['device_model_id', 'label'],
		osFamilies: ['id', 'display_name'],
		osVersions: ['os_family_id', 'version'],
		browsers: ['id', 'display_name', 'env_code'],
		browserVersions: ['browser_id', 'version'],
		deviceOsCompatibility: ['device_model_id', 'os_version_id'],
		browserPlatformSupport: ['browser_id', 'platform']
	};
	for (const field of required[entity] ?? []) {
		if (body[field] === undefined || body[field] === null || String(body[field]).trim() === '') {
			throw new CatalogValidationError(`Field "${field}" is required for ${entity}.`);
		}
	}
	if (entity === 'deviceCategories' && !['mobile', 'tablet', 'desktop'].includes(body.device_type)) {
		throw new CatalogValidationError('device_type must be mobile, tablet or desktop.');
	}
	if (entity === 'deviceCategories' && !PLATFORM_IDS.includes(body.platform)) {
		throw new CatalogValidationError(`platform must be one of: ${PLATFORM_IDS.join(', ')}.`);
	}
	if (entity === 'browserPlatformSupport' && !PLATFORM_IDS.includes(body.platform)) {
		throw new CatalogValidationError(`platform must be one of: ${PLATFORM_IDS.join(', ')}.`);
	}
	if (entity === 'osVersions' && !PLATFORM_IDS.includes(body.os_family_id)) {
		throw new CatalogValidationError(`os_family_id must be one of: ${PLATFORM_IDS.join(', ')}.`);
	}
	if (entity === 'deviceGenerations' && body.hardware_id !== undefined && body.hardware_id !== null) {
		// hardware optional — validated against the hardware table by the caller
	}
	return true;
}

function slugify(value) {
	return String(value).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function sortKeyForVersion(version) {
	const parts = String(version).split('.').map((part) => Number(part) || 0);
	return `${String(parts[0] ?? 0).padStart(6, '0')}.${String(parts[1] ?? 0).padStart(6, '0')}`;
}

export function createCatalogRoutes({ catalogBackend, onError }) {
	if (!catalogBackend) {
		throw new TypeError('Catalog routes require a device catalog backend.');
	}

	async function findExisting(entity, filters) {
		const rows = await catalogBackend.list(entity, filters);
		return rows[0] ?? null;
	}

	function route(app) {
		// ---- Compatibility validation (data-driven) -------------------------
		app.get('/api/catalog/validate', async (request, response) => {
			try {
				const { device, platform, osVersion, browser, browserVersion } = request.query;
				if (!device) {
					response.status(400).json({ error: 'device query parameter is required.' });
					return;
				}
				// Accept the display name ("Galaxy S24") as well as the slug (GALS24):
				// resolve display names through the catalog before validating.
				let deviceSlug = String(device);
				const models = await catalogBackend.list('deviceModels');
				const byName = models.find((candidate) => candidate.display_name === deviceSlug);
				if (byName) deviceSlug = byName.slug;
				const verdict = await catalogBackend.isCombinationSupported({
					deviceSlug,
					platform: platform ? String(platform) : undefined,
					osVersion: osVersion ? String(osVersion) : undefined,
					browserCode: browser ? String(browser).toLowerCase() : undefined,
					browserVersion: browserVersion ? String(browserVersion) : undefined
				});
				response.json(verdict);
			} catch (error) {
				onError(request, response, error);
			}
		});

		// ---- Catalog facet counts (Phase 3 UI) -------------------------------
		app.get('/api/catalog/facets', async (_request, response) => {
			try {
				const [categories, models, osVersions, browsers] = await Promise.all([
					catalogBackend.list('deviceCategories'),
					catalogBackend.list('deviceModels'),
					catalogBackend.list('osVersions'),
					catalogBackend.list('browsers')
				]);
				const byCategory = new Map();
				for (const model of models) {
					byCategory.set(model.category_id, (byCategory.get(model.category_id) ?? 0) + 1);
				}
				const byOsFamily = new Map();
				for (const os of osVersions) {
					byOsFamily.set(os.os_family_id, (byOsFamily.get(os.os_family_id) ?? 0) + 1);
				}
				response.set('Cache-Control', 'private, max-age=60');
				response.json({
					totalDeviceModels: models.length,
					totalOsVersions: osVersions.length,
					totalBrowsers: browsers.length,
					deviceCategories: [...byCategory.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count),
					osFamilies: [...byOsFamily.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count)
				});
			} catch (error) {
				onError(request, response, error);
			}
		});

		// ---- OS versions compatible with a device model -----------------------
		app.get('/api/catalog/deviceModels/:id/osVersions', async (request, response) => {
			try {
				const model = await findExisting('deviceModels', { id: request.params.id });
				if (!model) {
					response.status(404).json({ error: 'Unknown device model.' });
					return;
				}
				const rows = await modelCompatOsVersions(model.id);
				response.set('Cache-Control', 'private, max-age=60');
				response.json({ count: rows.length, rows });
			} catch (error) {
				onError(request, response, error);
			}
		});

		// ---- Browser versions for a browser (Phase 3 UI) -----------------------
		app.get('/api/catalog/browsers/:id/versions', async (request, response) => {
			try {
				const browser = await findExisting('browsers', { id: request.params.id });
				if (!browser) {
					response.status(404).json({ error: 'Unknown browser.' });
					return;
				}
				const rows = await catalogBackend.list('browserVersions', { browser_id: browser.id });
				response.set('Cache-Control', 'private, max-age=60');
				response.json({ count: rows.length, rows });
			} catch (error) {
				onError(request, response, error);
			}
		});

		/** Resolve a model's compatible OS versions through the compatibility table. */
		async function modelCompatOsVersions(modelId) {
			const category = await findExisting('deviceCategories', { id: (await findExisting('deviceModels', { id: modelId }))?.category_id });
			if (!category) return [];
			const familyId = category.platform === 'macos' ? 'macos' : category.platform;
			const osVersions = await catalogBackend.list('osVersions', { os_family_id: familyId });
			const compat = await catalogBackend.list('deviceOsCompatibility', { device_model_id: modelId });
			if (!compat.length) {
				// No explicit compatibility rows recorded → every version of the
				// platform's OS family is considered compatible with the model.
				return osVersions;
			}
			const supported = new Set(compat.map((row) => row.os_version_id));
			return osVersions.filter((os) => supported.has(os.id));
		}

		// ---- Entity reads ---------------------------------------------------
		app.get('/api/catalog/:entity', async (request, response) => {
			try {
				const entity = request.params.entity;
				if (!ENTITIES.includes(entity)) {
					response.status(400).json({ error: `Unknown catalog entity "${entity}".`, code: 'QASE_CATALOG_UNKNOWN_ENTITY' });
					return;
				}
				// Exact-match filters: accept only whitelisted column names per
				// entity (the backend already ignores unknown keys).
				const filters = {};
				for (const [key, value] of Object.entries(request.query)) {
					if (typeof value === 'string' && value !== '') filters[key] = value;
				}
				const rows = await catalogBackend.list(entity, filters);
				// Browsers carry the frozen catalog's per-platform availability so
				// client surfaces (device drawer) can hide unsupported combos.
				const payload = entity === 'browsers'
					? rows.map((row) => ({ ...row, platforms: BROWSER_PLATFORMS[row.id] ?? null }))
					: rows;
				response.set('Cache-Control', 'private, max-age=60');
				response.json({ count: payload.length, rows: payload });
			} catch (error) {
				onError(request, response, error);
			}
		});

		app.get('/api/catalog/:entity/:id', async (request, response) => {
			try {
				const entity = request.params.entity;
				if (!ENTITIES.includes(entity)) {
					response.status(400).json({ error: `Unknown catalog entity "${entity}".`, code: 'QASE_CATALOG_UNKNOWN_ENTITY' });
					return;
				}
				const idKey = entity === 'deviceOsCompatibility' ? 'device_model_id' : 'id';
				const row = await findExisting(entity, { [idKey]: request.params.id });
				if (!row) {
					response.status(404).json({ error: 'Unknown catalog entry.' });
					return;
				}
				response.set('Cache-Control', 'private, max-age=60');
				response.json(row);
			} catch (error) {
				onError(request, response, error);
			}
		});

		// ---- Entity creates -------------------------------------------------
			app.post('/api/catalog/:entity', async (request, response) => {
				try {
					const entity = request.params.entity;
					if (!ENTITIES.includes(entity)) {
						response.status(400).json({ error: `Unknown catalog entity "${entity}".`, code: 'QASE_CATALOG_UNKNOWN_ENTITY' });
						return;
					}
					// Catalog rows are global reference data — restrict writes to
					// owner/admin when role info is present (no-op when auth is off).
					const role = request.auth?.role;
					if (role && !['owner', 'admin'].includes(role)) {
						response.status(403).json({ error: 'Catalog writes require an owner or administrator.' });
						return;
					}
				const body = request.body ?? {};
				validateCreatePayload(entity, body);

				// Derived + defaulted fields per entity
				const payload = { ...body };
				if (entity === 'deviceModels') {
					if (!payload.slug) payload.slug = slugify(payload.display_name);
				}
				if (entity === 'deviceModels' && !payload.id) payload.id = payload.slug;
				if (entity === 'osVersions' && !payload.display) {
					const family = await findExisting('osFamilies', { id: payload.os_family_id });
					if (!family) throw new CatalogValidationError(`Unknown OS family "${payload.os_family_id}".`);
					payload.display = `${family.display_name} ${payload.version}`;
				}
				if (entity === 'osVersions' && !payload.sort_key) {
					payload.sort_key = sortKeyForVersion(payload.version);
				}
				if (entity === 'osVersions' && payload.major === undefined) {
					const major = Number(String(payload.version).split('.')[0]);
					if (!Number.isInteger(major) || major < 0) {
						throw new CatalogValidationError('version must start with a numeric major segment (e.g. "26.1").');
					}
					payload.major = major;
				}
				if (entity === 'browserVersions' && !payload.sort_key) {
					payload.sort_key = sortKeyForVersion(payload.version);
				}
				if (entity === 'browsers' && payload.independently_versioned === undefined) {
					payload.independently_versioned = true;
				}

				// Foreign-key style guards so errors are clear 422s, not FK crashes.
				if (entity === 'deviceModels' && !(await findExisting('deviceCategories', { id: payload.category_id }))) {
					throw new CatalogValidationError(`Unknown device category "${payload.category_id}".`);
				}
				if (entity === 'deviceModels' && payload.hardware_id && !(await findExisting('hardware', { id: payload.hardware_id }))) {
					throw new CatalogValidationError(`Unknown hardware "${payload.hardware_id}".`);
				}
				if (entity === 'browserVersions' && !(await findExisting('browsers', { id: payload.browser_id }))) {
					throw new CatalogValidationError(`Unknown browser "${payload.browser_id}".`);
				}
				if (entity === 'osVersions' && !(await findExisting('osFamilies', { id: payload.os_family_id }))) {
					throw new CatalogValidationError(`Unknown OS family "${payload.os_family_id}".`);
				}
				if (entity === 'deviceGenerations' && !(await findExisting('deviceModels', { id: payload.device_model_id }))) {
					throw new CatalogValidationError(`Unknown device model "${payload.device_model_id}".`);
				}
				if (entity === 'deviceGenerations' && payload.hardware_id && !(await findExisting('hardware', { id: payload.hardware_id }))) {
					throw new CatalogValidationError(`Unknown hardware "${payload.hardware_id}".`);
				}
				if (entity === 'deviceOsCompatibility'
					&& !(await findExisting('deviceModels', { id: payload.device_model_id }))) {
					throw new CatalogValidationError(`Unknown device model "${payload.device_model_id}".`);
				}
				if (entity === 'deviceOsCompatibility'
					&& !(await findExisting('osVersions', { id: payload.os_version_id }))) {
					throw new CatalogValidationError(`Unknown OS version "${payload.os_version_id}".`);
				}

				// Versioned entities are create-only: duplicates are a 409, not a
				// silent overwrite (reference entities upsert instead).
				if (!UPSERT_ENTITIES.has(entity)) {
					const conflictFilters = {
						deviceModels: { slug: payload.slug },
						deviceGenerations: { device_model_id: payload.device_model_id, label: payload.label },
						osVersions: { os_family_id: payload.os_family_id, version: payload.version },
						browserVersions: { browser_id: payload.browser_id, version: payload.version },
						deviceOsCompatibility: { device_model_id: payload.device_model_id, os_version_id: payload.os_version_id }
					}[entity];
					const existing = conflictFilters ? await findExisting(entity, conflictFilters) : null;
					if (existing) {
						const conflict = new CatalogConflictError(`${entity} entry already exists.`);
						conflict.detail = { existing };
						throw conflict;
					}
				}

				const stored = await catalogBackend.create(entity, payload);
				response.status(201).json(stored);
			} catch (error) {
				if (error?.code === 'QASE_CATALOG_INVALID') {
					response.status(422).json({ error: error.message, code: error.code });
					return;
				}
				if (error?.code === 'QASE_CATALOG_CONFLICT') {
					response.status(409).json({ error: error.message, code: error.code, detail: error.detail });
					return;
				}
				onError(request, response, error);
			}
		});
	}

	return { route };
}

export { EnvironmentValidationError };
