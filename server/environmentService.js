import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
	generateEnvironments,
	getDevice,
	isCombinationSupported,
	getPlatform,
	BROWSERS,
	safariVersionFor,
	buildEnvId,
	buildProfileId,
	availabilityReport,
	ENVIRONMENT_CATALOG_VERSION
} from './environmentCatalog.js';
import { resolveBrowserSupportSync } from './browserSupportResolution.js';

/** Index of the frozen catalog by envId for metadata lookups. */
const CATALOG_BY_ENV_ID = new Map(generateEnvironments().map((env) => [env.envId, env]));
function findCatalogEnvironment(envId) {
	return CATALOG_BY_ENV_ID.get(envId) ?? null;
}
import {
	normalizePermissionScenario,
	normalizeOrientationScenario,
	platformRuntimeProfile
} from './deviceRuntimeProfiles.js';

/**
 * Environment application service.
 *
 * Uniform, camelCase service surface over two backends:
 *  - local JSON file (.qase/environments.json), mirroring store.js conventions
 *  - PostgreSQL environments table (server/postgres/environmentRepository.js)
 *
 * Both backends implement: seed(tenant), list(tenant, filters), get(tenant, envId),
 * create(tenant, input), update(tenant, envId, patch). Seed is idempotent and
 * never resets `active` — operator deprecations survive catalog refreshes on
 * both backends.
 */

export class EnvironmentValidationError extends Error {
	constructor(message) {
		super(message);
		this.name = 'EnvironmentValidationError';
		this.code = 'QASE_ENVIRONMENT_INVALID';
	}
}

export class EnvironmentConflictError extends Error {
	constructor(envId) {
		super(`Environment ${envId} already exists.`);
		this.name = 'EnvironmentConflictError';
		this.code = 'QASE_ENVIRONMENT_CONFLICT';
		this.envId = envId;
	}
}

export async function normalizeEnvironmentInput(input, options = {}) {
	if (!input || typeof input !== 'object') {
		throw new EnvironmentValidationError('An environment payload is required.');
	}

	const platformId = input.platform;
	const osVersion = typeof input.osVersion === 'string' ? input.osVersion.trim() : input.osVersion;
	const browserVersion = input.browserVersion !== undefined && input.browserVersion !== null
		? String(input.browserVersion).trim()
		: undefined;

	// Prefer the DB-backed catalog (migration 016) when attached; the frozen
	// module remains the fallback so standalone/testing usage still validates.
	const device = getDevice(input.device);
	let verdict;
	if (device && options.catalogBackend?.isCombinationSupported) {
		verdict = await options.catalogBackend.isCombinationSupported({
			deviceSlug: device.slug,
			platform: platformId,
			osVersion,
			browserCode: String(input.browserCode ?? input.browser ?? '').toLowerCase(),
			browserVersion
		});
	} else {
		verdict = isCombinationSupported(platformId, input.device, osVersion, input.browserCode ?? input.browser, browserVersion);
	}
	if (!verdict.ok) throw new EnvironmentValidationError(verdict.reason);

	const platform = getPlatform(platformId);
	const browser = BROWSERS.find((candidate) => candidate.code === String(input.browserCode ?? input.browser ?? '').toLowerCase());
	const resolvedVersion = browser.code === 'safari'
		? safariVersionFor(platformId, osVersion)
		: browserVersion;
	const executionProvider = input.executionProvider === 'local' ? 'local' : 'browserstack';

	// Screen resolution + orientation (request section 5): explicit values win;
	// otherwise default from the device model. Desktop devices have no
	// orientation (not applicable), mobile/tablet default to portrait.
	const orientation = device.deviceType === 'desktop'
		? null
		: (input.orientation === 'landscape' ? 'landscape' : 'portrait');
	const screenResolution = typeof input.screenResolution === 'string' && input.screenResolution.trim() !== ''
		? input.screenResolution.trim()
		: (device.emulation?.viewport
			? `${device.emulation.viewport.width}x${device.emulation.viewport.height}`
			: null);

	// Phase 20 permission + orientation scenarios: whitelisted values only,
	// validated against the platform profile (rotate-during-test needs touch).
	const deviceTypeForScenario = device.deviceType;
	let permissionScenario;
	try {
		permissionScenario = normalizePermissionScenario(input.permissionScenario);
	} catch (error) {
		throw new EnvironmentValidationError(error.message);
	}
	let orientationScenario;
	try {
		orientationScenario = normalizeOrientationScenario(input.orientationScenario, { deviceType: deviceTypeForScenario });
	} catch (error) {
		throw new EnvironmentValidationError(error.message);
	}
	const requestedLevel = ['REAL_DEVICE', 'VIRTUAL_DEVICE', 'SIMULATED'].includes(input.executionLevelRequested)
		? input.executionLevelRequested
		: null;

	const envId = options.envId ?? buildEnvId(platformId, device.slug, osVersion, browser.envCode, resolvedVersion);
	// Custom environments (explicit envId) build on a catalog combination but
	// are distinct rows — suffix the alias so it can never collide with the
	// builtin environment's profile_id (index is non-unique anyway, but stable
	// aliases must stay unambiguous in reporting).
	const profileId = options.envId
		? `${buildProfileId(platformId, device.slug, osVersion, browser.code, resolvedVersion)}-${options.envId.toLowerCase().replace(/[^a-z0-9]+/g, '')}`
		: buildProfileId(platformId, device.slug, osVersion, browser.code, resolvedVersion);

	return {
		envId,
		profileId,
		platform: platformId,
		platformLabel: platform.label,
		device: device.name,
		os: platform.os,
		osVersion,
		browser: browser.name,
		browserCode: browser.code,
		browserVersion: String(resolvedVersion),
		deviceType: device.deviceType,
		screenSize: device.screenSize,
		screenResolution,
		orientation,
		description: typeof input.description === 'string' ? input.description.trim() : null,
		executionProvider,
		isRealDevice: device.isRealDevice && executionProvider === 'browserstack',
		active: true,
		permissionScenario,
		orientationScenario,
		executionLevelRequested: requestedLevel,
		runtimeCapabilities: capabilitiesFor(device, platformId, osVersion, browser, resolvedVersion)
	};
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
	if (platformId === 'android') {
		return {
			browserName: browser.code,
			browserVersion: String(browserVersion),
			os: 'android',
			osVersion,
			deviceName: device.browserstackDeviceName,
			realMobile: true
		};
	}
	if (platformId === 'windows') {
		// Windows form factors run as desktop browser sessions (no deviceName);
		// the OS version is the major Windows release.
		const windowsMajor = /(\d+(?:\.\d+)*)\s*$/.exec(String(osVersion).trim())?.[1] ?? osVersion;
		return {
			browserName: browser.code,
			browserVersion: String(browserVersion),
			os: 'Windows',
			osVersion: windowsMajor
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

/** snake_case DB row -> camelCase environment record (idempotent on local records). */
export function rowToEnvironment(row) {
	if (!row || typeof row !== 'object') return row;
	return {
		id: row.id,
		envId: row.env_id ?? row.envId,
		profileId: row.profile_id ?? row.profileId
			// Rows persisted before 2027.03.0 carry no profile_id column — derive
			// it deterministically (frozen catalog lookup, else from row fields)
			// so the alias is always present on read.
			?? findCatalogEnvironment(row.env_id ?? row.envId)?.profileId
			?? (row.device_model_slug && row.platform
				? buildProfileId(row.platform, row.device_model_slug, row.os_version ?? row.osVersion, row.browser_code ?? row.browserCode, row.browser_version ?? row.browserVersion)
				: undefined),
		platform: row.platform,
		platformLabel: row.platform_label ?? row.platformLabel,
		device: row.device,
		os: row.os,
		osVersion: row.os_version ?? row.osVersion,
		browser: row.browser,
		browserCode: row.browser_code ?? row.browserCode,
		browserVersion: row.browser_version ?? row.browserVersion,
		deviceType: row.device_type ?? row.deviceType,
		screenSize: row.screen_size ?? row.screenSize,
		screenResolution: row.screen_resolution ?? row.screenResolution,
		orientation: row.orientation,
		deviceModelSlug: row.device_model_slug ?? row.deviceModelSlug,
		manufacturer: row.manufacturer,
		description: row.description,
		executionProvider: row.execution_provider ?? row.executionProvider,
		isRealDevice: row.is_real_device ?? row.isRealDevice,
		active: row.active,
		permissionScenario: row.permission_scenario ?? row.permissionScenario ?? null,
		orientationScenario: row.orientation_scenario ?? row.orientationScenario ?? null,
		executionLevelRequested: row.execution_level_requested ?? row.executionLevelRequested ?? null,
		runtimeCapabilities: row.browserstack_capabilities ?? row.runtimeCapabilities ?? row.runtimeCapabilities,
		createdAt: row.created_at ?? row.createdAt,
		updatedAt: row.updated_at ?? row.updatedAt
	};
}

/**
 * Phase D1 · Strict execution-type + device metadata contract.
 * Every environment handed to the UI/API carries exactly one of
 * REAL_DEVICE / VIRTUAL_DEVICE / SIMULATED plus the full metadata field set
 * the device panel and matrix render. Nothing here invents hardware: the
 * execution type is derived from the runtime manager's honest level, never
 * from a device name or profile flag.
 */

/** Runtime metadata attached per environment. `runtimeSessionId`/`runtimeStatus`
 * are null/unavailable until a runtime session exists for this environment.
 * R1 #14490: honest baseline — a catalog row never claims AVAILABLE by
 * default; the device runtime board (seeded per environment at boot) is the
 * only source that upgrades it. */
const RUNTIME_PLACEHOLDER = Object.freeze({
	runtimeSessionId: null,
	runtimeStatus: 'UNAVAILABLE',
	lastTested: null,
	lastResult: null
});

/** Derive device_pixel_ratio / resolution from the frozen catalog emulation. */
function emulationMetadata(env) {
	const catalogEntry = findCatalogEnvironment(env.envId);
	const dpr = catalogEntry?.emulation?.deviceScaleFactor
		?? env.devicePixelRatio
		?? (env.deviceType === 'desktop' ? 1 : 2);
	const resolution = env.screenResolution
		?? (catalogEntry?.emulation?.viewport
			? `${catalogEntry.emulation.viewport.width}×${catalogEntry.emulation.viewport.height}`
			: null);
	return { devicePixelRatio: dpr, resolution };
}

/** Enrich an environment record with execution_type and metadata fields. */
export function withExecutionMetadata(env) {
	if (!env || typeof env !== 'object') return env;
	const level = env.executionLevelRequested === 'REAL_DEVICE' && env.isRealDevice
		? 'REAL_DEVICE'
		: env.executionLevelRequested === 'SIMULATED'
			? 'SIMULATED'
			: 'VIRTUAL_DEVICE';
	const { devicePixelRatio, resolution } = emulationMetadata(env);
	// #14632 (NI01 Phase 2): browser-level executability travels with every
	// environment read so the picker, run start, and findings all see the same
	// provider-derived truth (duckduckgo=NOT SUPPORTED, opera/brave/safari
	// engine-equivalent locally, …). Recomputed on read — never cached.
	// RT1 (#14680): sync resolution against the last registry probe — no
	// external provider participates; branded binaries upgrade honestly.
	const browserSupport = resolveBrowserSupportSync(env.platform, env.browserCode);
	return {
		...env,
		executionType: level,
		browserSupport,
		deviceId: env.deviceModelSlug ?? env.envId,
		// #15123: prefer the catalog's real manufacturer (Samsung, Google, …);
		// the previous first-word-of-device fallback produced "Galaxy Galaxy
		// S24" / "Pixel Pixel Tablet" in the launcher matrix.
		deviceManufacturer: env.manufacturer
			?? env.deviceManufacturer
			?? (env.platform === 'ios' || env.platform === 'ipados' || env.platform === 'macos'
				? 'Apple'
				: env.platform === 'android' ? (env.device?.split(' ')[0] ?? 'Android') : 'Microsoft'),
		deviceModel: env.device,
		hardwareIdentifier: env.hardwareIdentifier ?? env.deviceModelSlug ?? null,
		os: env.os,
		osVersion: env.osVersion,
		browser: env.browser,
		browserVersion: env.browserVersion,
		resolution,
		devicePixelRatio,
		orientation: env.orientation ?? (env.deviceType === 'desktop' ? 'landscape' : 'portrait'),
		touchSupport: env.deviceType !== 'desktop',
		cameraSupport: env.deviceType !== 'desktop',
		microphoneSupport: true,
		screenCaptureSupport: env.deviceType === 'desktop' || env.platform === 'macos',
		gpsSupport: env.deviceType !== 'desktop',
		networkProfile: env.networkProfile ?? 'default',
		availability: env.active ? RUNTIME_PLACEHOLDER.runtimeStatus : 'OFFLINE',
		...RUNTIME_PLACEHOLDER,
		...(env.runtimeSessionId !== undefined ? { runtimeSessionId: env.runtimeSessionId } : {})
	};
}

// ---------------------------------------------------------------------------
// Local file backend
// ---------------------------------------------------------------------------

export function createLocalEnvironmentBackend(options = {}) {
	const stateDir = options.stateDir ?? path.join(process.cwd(), '.qase');
	const stateFile = options.stateFile ?? path.join(stateDir, 'environments.json');
	const catalogBackend = options.catalogBackend ?? null;
	/** @type {Map<string, any>} */
	const byEnvId = new Map();
	let loaded = false;
	/**
	 * #14275: seed provider-overlay sources. The factory registers external
	 * providers in the module registry; a lazily-imported helper avoids a
	 * circular import (catalogProviderRegistry imports environmentCatalog
	 * only, but environmentService → registry → catalog is kept one-way).
	 */
	async function providerRegistrySlugs() {
		try {
			const { registeredCatalogProviders } = await import('./catalogProviderRegistry.js');
			return registeredCatalogProviders()
				.filter((provider) => provider.connected !== false)
				.map((provider) => provider.slug);
		} catch {
			return [];
		}
	}

	function loadFromDisk() {
		if (loaded) return;
		loaded = true;
		try {
			const raw = fs.readFileSync(stateFile, 'utf8');
			const parsed = JSON.parse(raw);
			for (const record of Array.isArray(parsed) ? parsed : []) {
				if (record?.envId) byEnvId.set(record.envId, record);
			}
		} catch {
			/* first boot or unreadable file — the seed below recreates it */
		}
	}

	function persistNow() {
		try {
			fs.mkdirSync(stateDir, { recursive: true });
			const tmp = `${stateFile}.tmp-${process.pid}-${randomUUID()}`;
			fs.writeFileSync(tmp, JSON.stringify([...byEnvId.values()], undefined, '\t'), { mode: 0o600 });
			fs.renameSync(tmp, stateFile);
		} catch {
			/* a dashboard that cannot write its environment file is still usable */
		}
	}

	/** Same filtered-list semantics as the SQL backend, in memory. */
	function filterRecords(filters = {}) {
		const term = filters.search ? String(filters.search).toLowerCase() : '';
		return [...byEnvId.values()].filter((record) => {
			if (filters.platform && record.platform !== filters.platform) return false;
			if (filters.platformGroup && !filters.platformGroup.includes(record.platform)) return false;
			if (filters.device && record.device !== filters.device) return false;
			if (filters.os && record.os !== filters.os) return false;
			if (filters.osVersion && record.osVersion !== filters.osVersion) return false;
			if (filters.browser && record.browser !== filters.browser) return false;
			if (filters.browserCode && record.browserCode !== filters.browserCode) return false;
			if (filters.browserVersion && record.browserVersion !== String(filters.browserVersion)) return false;
			if (filters.deviceType && record.deviceType !== filters.deviceType) return false;
			if (filters.executionProvider && record.executionProvider !== filters.executionProvider) return false;
			if (filters.orientationScenario && (record.orientationScenario ?? '') !== filters.orientationScenario) return false;
			if (filters.executionLevelRequested && (record.executionLevelRequested ?? '') !== filters.executionLevelRequested) return false;
			if (filters.isRealDevice !== undefined && filters.isRealDevice !== null && filters.isRealDevice !== '') {
				if (record.isRealDevice !== (filters.isRealDevice === true || filters.isRealDevice === 'true')) return false;
			}
			if (filters.active !== undefined && filters.active !== null && filters.active !== '') {
				if (record.active !== (filters.active === true || filters.active === 'true')) return false;
			}
			if (term) {
				const haystack = `${record.envId} ${record.device} ${record.browser}`.toLowerCase();
				if (!haystack.includes(term)) return false;
			}
			return true;
		}).sort((left, right) => `${left.platform}|${left.device}|${left.osVersion}|${left.browser}|${left.browserVersion}`
			.localeCompare(`${right.platform}|${right.device}|${right.osVersion}|${right.browser}|${right.browserVersion}`));
	}

	return {
		/**
		 * Seed is idempotent and never resets `active` — operator deprecations
		 * survive catalog refreshes. #14275 (Phase 2): builtin rows come from
		 * the frozen catalog generator; registered connected providers
		 * contribute their overlay rows (namespaced PROV- envIds) on top so a
		 * fresh seed sees provider data too. Registry failure never blocks
		 * seeding — builtin remains authoritative.
		 */
		async seed() {
			loadFromDisk();
			const generated = generateEnvironments();
			const generatedIds = new Set(generated.map((env) => env.envId));
			for (const env of generated) {
				const existing = byEnvId.get(env.envId);
				byEnvId.set(env.envId, existing ? { ...env, active: existing.active } : { id: randomUUID(), ...env });
			}
			// #14275: provider overlay rows (additive, PROV- namespaced).
			let providerRows = 0;
			try {
				const { mergeCatalog } = await import('./catalogProviderRegistry.js');
				const merged = await mergeCatalog(['builtin', ...(await providerRegistrySlugs())]);
				for (const env of merged.environments) {
					if (!String(env.envId).startsWith('PROV-')) continue;
					const existing = byEnvId.get(env.envId);
					byEnvId.set(env.envId, existing ? { ...env, active: existing.active, id: existing.id } : { id: randomUUID(), ...env });
					providerRows += 1;
				}
			} catch {
				/* registry unavailable → builtin-only seed, builtin stays authoritative */
			}
			// 2027.01.0 (#14273): retired catalog rows (e.g. the macOS
			// one-pseudo-device-per-OS entries replaced by hardware models)
			// are deactivated, never deleted — old references stay resolvable.
			// Provider rows are never retired by a builtin-only refresh.
			const providerPrefix = 'PROV-';
			for (const [envId, record] of byEnvId) {
				if (envId.startsWith(providerPrefix)) continue;
				if (!generatedIds.has(envId) && record.active !== false) {
					byEnvId.set(envId, { ...record, active: false, retiredFromCatalog: ENVIRONMENT_CATALOG_VERSION });
				}
			}
			persistNow();
			return { inserted: byEnvId.size, providerRows, catalogVersion: ENVIRONMENT_CATALOG_VERSION };
		},
		async list(tenant, filters = {}) {
			loadFromDisk();
			const all = filterRecords(filters);
			const offset = Math.max(Number(filters.offset ?? 0), 0);
			// 2027.01.0 (#14273): matrix grew to ~36.6k rows — clamp raised so
			// one-shot picker fetches still see the full catalog.
			const limit = Math.min(Math.max(Number(filters.limit ?? 500), 1), 80000);
			return all.slice(offset, offset + limit);
		},
		async get(tenant, envId) {
			loadFromDisk();
			return byEnvId.get(envId) ?? null;
		},
		async create(tenant, input) {
			loadFromDisk();
			const record = await normalizeEnvironmentInput(input, { catalogBackend });
			if (byEnvId.has(record.envId)) throw new EnvironmentConflictError(record.envId);
			const stored = { id: randomUUID(), ...record };
			byEnvId.set(stored.envId, stored);
			persistNow();
			return stored;
		},
		async update(tenant, envId, patch) {
			loadFromDisk();
			const record = byEnvId.get(envId);
			if (!record) return null;
			if (patch && typeof patch.active === 'boolean') record.active = patch.active;
			if (patch && (patch.executionProvider === 'local' || patch.executionProvider === 'browserstack')) {
				record.executionProvider = patch.executionProvider;
			}
			if (patch && typeof patch.screenResolution === 'string' && patch.screenResolution.trim() !== '') {
				record.screenResolution = patch.screenResolution.trim();
			}
			if (patch && (patch.orientation === 'portrait' || patch.orientation === 'landscape')) {
				record.orientation = patch.orientation;
			}
			if (patch && typeof patch.description === 'string') {
				record.description = patch.description.trim();
			}
			// Phase 20 scenarios: validated patches only — an invalid scenario
			// value is rejected, never silently ignored. Explicit null clears.
			if (patch && patch.permissionScenario !== undefined) {
				try {
					const scenario = normalizePermissionScenario(patch.permissionScenario);
					record.permissionScenario = scenario ?? null;
				} catch (error) {
					throw new EnvironmentValidationError(error.message);
				}
			}
			if (patch && patch.orientationScenario !== undefined) {
				try {
					record.orientationScenario = normalizeOrientationScenario(patch.orientationScenario, {
						deviceType: record.deviceType
					});
				} catch (error) {
					throw new EnvironmentValidationError(error.message);
				}
			}
			record.updatedAt = new Date().toISOString();
			persistNow();
			return record;
		},
		async remove(tenant, envId) {
			loadFromDisk();
			if (!byEnvId.has(envId)) return false;
			byEnvId.delete(envId);
			persistNow();
			return true;
		},
		/**
		 * #14275 (Phase 2): upsert one provider-scoped row (envId starts with
		 * `PROV-`). Idempotent: an existing row keeps its `active` state —
		 * provider refreshes never toggle operator decisions, they only
		 * add/update provider data. Builtin rows are never passed here.
		 */
		async upsertProviderRow(tenant, row) {
			if (!row || typeof row.envId !== 'string' || !row.envId.startsWith('PROV-')) {
				throw new EnvironmentValidationError('provider rows must use PROV- namespaced envIds');
			}
			loadFromDisk();
			const existing = byEnvId.get(row.envId);
			const stored = existing
				? { ...existing, ...row, active: existing.active, id: existing.id }
				: { id: randomUUID(), ...row };
			byEnvId.set(stored.envId, stored);
			persistNow();
			return stored;
		}
	};
}

// ---------------------------------------------------------------------------
// Service facade over either backend
// ---------------------------------------------------------------------------

const FILTER_KEYS = [
	'platform', 'device', 'os', 'osVersion', 'browser', 'browserCode', 'browserVersion',
	'deviceType', 'executionProvider', 'isRealDevice', 'active', 'search', 'limit', 'offset',
	'orientationScenario', 'executionLevelRequested'
];

export function sanitizeFilters(query = {}) {
	const filters = {};
	for (const key of FILTER_KEYS) {
		const value = query[key];
		if (value === undefined || value === null || value === '') continue;
		filters[key] = value;
	}
	// Phase D4: platform group (Apple/Android/Windows) expands to its OS
	// platforms; the UI sends a comma list.
	if (typeof filters.platform === 'string' && filters.platform.includes(',')) {
		filters.platformGroup = filters.platform.split(',').map((item) => item.trim()).filter(Boolean);
		delete filters.platform;
	}
	return filters;
}

export function createEnvironmentService(backend, options = {}) {
	const tenantContext = options.tenantContext;
	const withTenant = (tenant) => tenant ?? tenantContext ?? {};
	/** #14275: rate-limit anchor for refreshCatalog (1/min). */
	let refreshCatalogLastAt = 0;
	/** Catalog backend (device/OS/browser reference data) — attached by the factory. */
	let catalogBackend = null;

	async function list(filters = {}) {
		const rows = await backend.list(withTenant(), sanitizeFilters(filters));
		return rows.map((row) => withExecutionMetadata(rowToEnvironment(row)));
	}

	async function get(envId) {
		return withExecutionMetadata(rowToEnvironment(await backend.get(withTenant(), envId)));
	}

	async function create(input) {
		return withExecutionMetadata(rowToEnvironment(await backend.create(withTenant(), input)));
	}

	async function update(envId, patch) {
		return withExecutionMetadata(rowToEnvironment(await backend.update(withTenant(), envId, patch)));
	}

	async function remove(envId) {
		return Boolean(await backend.remove(withTenant(), envId));
	}

	/** Facet values (with counts) over the filtered set, for the admin UI dropdowns. */
	async function facets(filters = {}) {
		const clean = sanitizeFilters(filters);
		const facetQuery = { ...clean, limit: 80000, offset: 0 };
		const rows = (await backend.list(withTenant(), facetQuery)).map(rowToEnvironment);
		const dimension = (key) => {
			const counts = new Map();
			for (const row of rows) {
				const value = row[key];
				counts.set(value, (counts.get(value) ?? 0) + 1);
			}
			return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
		};
		const executionLevelDimension = () => {
			// #14275: executionLevels facet derived via withExecutionMetadata so
			// provider rows and legacy rows map to the strict level vocabulary.
			const counts = new Map();
			for (const row of rows.map((row) => withExecutionMetadata(row))) {
				const level = row.executionLevel ?? row.executionLevelRequested ?? 'SIMULATED';
				counts.set(level, (counts.get(level) ?? 0) + 1);
			}
			return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
		};
		const providerDimension = () => {
			// #14275: providers facet — builtin rows report 'builtin',
			// provider rows carry their providerSlug.
			const counts = new Map();
			for (const row of rows) {
				const value = row.providerSlug ?? 'builtin';
				counts.set(value, (counts.get(value) ?? 0) + 1);
			}
			return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
		};
		return {
			total: rows.length,
			platform: dimension('platform'),
			device: dimension('device'),
			os: dimension('os'),
			osVersion: dimension('osVersion'),
			browser: dimension('browser'),
			browserVersion: dimension('browserVersion'),
			deviceType: dimension('deviceType'),
			executionProvider: dimension('executionProvider'),
			isRealDevice: dimension('isRealDevice'),
			active: dimension('active'),
			executionLevels: executionLevelDimension(),
			providers: providerDimension()
		};
	}

	return {
		seed: () => backend.seed(withTenant()),
		list,
		get,
		create,
		update,
		remove,
		facets,
		// #14632: availability resolution re-computed per call. RT1 (#14680):
		// the local browser registry is the only provider — real branded
		// binaries, launch-verified; a stale 'supported' verdict must never
		// survive a registry change.
		availability: () => availabilityReport({}),
		catalogVersion: () => ENVIRONMENT_CATALOG_VERSION,
		/**
		 * #14275 (Phase 2): manual/API-triggered catalog refresh. Re-fetches
		 * provider overlays via the catalog provider registry and upserts
		 * ONLY provider-scoped rows (envIds starting `PROV-`); builtin rows
		 * are never touched. Rate-limited to one refresh per minute.
		 */
		async refreshCatalog(registryModule) {
			const registryApi = registryModule ?? (await import('./catalogProviderRegistry.js'));
			if (refreshCatalogLastAt && Date.now() - refreshCatalogLastAt < 60_000) {
				return { refreshed: false, reason: 'rate-limited', providers: [] };
			}
			refreshCatalogLastAt = Date.now();
			const merged = await registryApi.mergeCatalog();
			for (const env of merged.environments) {
				if (!String(env.envId).startsWith('PROV-')) continue;
				if (typeof backend.upsertProviderRow === 'function') {
					await backend.upsertProviderRow(withTenant(), env);
				}
			}
			return {
				refreshed: true,
				catalogVersion: merged.builtinVersion,
				attestations: merged.attestations.length,
				providers: merged.providers
			};
		},
		/** Optional catalog backend (migration 016) — set by the service factory. */
		attachCatalog: (catalog) => { catalogBackend = catalog; },
		catalog: () => catalogBackend,
		/** Bulk create: validate every combination, create the valid ones, skip the rest. */
		async bulkCreate(inputs = []) {
			if (!Array.isArray(inputs)) throw new EnvironmentValidationError('combinations must be an array.');
			if (inputs.length > 500) throw new EnvironmentValidationError('combinations is limited to 500 entries per request.');
			const created = [];
			const skipped = [];
			for (const input of inputs) {
				try {
					created.push(await backend.create(withTenant(), input));
				} catch (error) {
					if (error?.code === 'QASE_ENVIRONMENT_CONFLICT' || error?.code === 'QASE_ENVIRONMENT_INVALID') {
						skipped.push({ input, reason: error.message, code: error.code });
					} else {
						throw error;
					}
				}
			}
			return { created: created.map(rowToEnvironment), skipped, total: inputs.length };
		},
		/** Bulk enable/disable by envId list. Unknown ids are reported, not fatal. */
		async bulkToggleActive(envIds = [], active = true) {
			const updated = [];
			const missing = [];
			for (const envId of envIds) {
				const row = await backend.update(withTenant(), String(envId), { active: Boolean(active) });
				if (row) updated.push(rowToEnvironment(row));
				else missing.push(envId);
			}
			return { updated, missing, active: Boolean(active) };
		}
	};
}
