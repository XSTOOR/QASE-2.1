import {
	generateEnvironments,
	BROWSERS,
	BROWSER_VERSIONS,
	safariVersionFor
} from './environmentCatalog.js';
import { resolveBrowserSupportSync } from './browserSupportResolution.js';

/**
 * Launcher configuration catalog (Phase 1 of the QA device/browser matrix).
 *
 * One honest source for the Start QA dialog: every ACTIVE environment row,
 * joined with the browser-support resolution (real branded binaries, engine
 * equivalences, honest not_supported reasons) and the runtime-board
 * availability, presented as device–OS–browser–version configurations.
 *
 * No new catalog data source, no invented versions — everything derives from
 * the existing environment catalog (frozen builtin generator + provider
 * overlay rows merged by the environment service).
 */

/** Display order for the seven families in the launcher checklist. */
export const FAMILY_ORDER = ['edge', 'chrome', 'brave', 'firefox', 'safari', 'opera', 'duckduckgo'];

/** Execution-type vocabulary shown in the launcher. */
export const EXECUTION_TYPES = {
	PHYSICAL_DEVICE: 'physical_device',
	VIRTUAL_MACHINE: 'virtual_machine',
	EMULATOR: 'emulator',
	SIMULATOR: 'simulator',
	BROWSER_EMULATION: 'browser_emulation'
};

/**
 * Map an environment row to the launcher execution-type vocabulary.
 * Honest mapping from the strict levels the service already computes:
 *  - REAL_DEVICE    → physical_device
 *  - VIRTUAL_DEVICE → virtual_machine
 *  - SIMULATED on a mobile/tablet profile → emulator
 *  - SIMULATED engine-equivalent browser  → simulator
 *  - SIMULATED everything else            → browser_emulation
 */
export function executionTypeFor(env) {
	// environmentService.withExecutionMetadata stamps a DEFAULT
	// executionType='VIRTUAL_DEVICE' on every catalog row when no explicit
	// level was requested; honoring that default here collapsed the whole
	// catalog to "Virtual machine" and the honest emulator/simulator/
	// browser-emulation labels never rendered (#15123). Only an EXPLICIT
	// request (executionLevelRequested / executionLevel) carries the strict
	// level; the blanket executionType stamp is ignored and the type is
	// derived from platform + browser support instead.
	const level = env.executionLevelRequested ?? env.executionLevel ?? null;
	if (level === 'REAL_DEVICE') return EXECUTION_TYPES.PHYSICAL_DEVICE;
	if (level === 'VIRTUAL_DEVICE') return EXECUTION_TYPES.VIRTUAL_MACHINE;
	const mobile = env.deviceType === 'mobile' || env.deviceType === 'tablet'
		|| String(env.platform ?? '') === 'android'
		|| String(env.platform ?? '') === 'ios'
		|| String(env.platform ?? '') === 'ipados';
	if (mobile) {
		const support = env.browserSupport?.status;
		if (support === 'engine_equivalent') return EXECUTION_TYPES.SIMULATOR;
		return EXECUTION_TYPES.EMULATOR;
	}
	const support = env.browserSupport?.status;
	if (support === 'engine_equivalent') return EXECUTION_TYPES.SIMULATOR;
	return EXECUTION_TYPES.BROWSER_EMULATION;
}

/**
 * Availability tri-state for the launcher:
 *  - NOT_SUPPORTED — browser family cannot execute (checkbox disabled, reason shown)
 *  - NOT_CONFIGURED — a provider/credential the row needs is missing (BrowserStack unset)
 *  - UNAVAILABLE — present in the catalog but the runtime board says it cannot run now
 *  - AVAILABLE — selectable
 */
export function availabilityFor(env, boardByEnvId, providers) {
	if (env.browserSupport?.status === 'not_supported') {
		return { availability: 'NOT_SUPPORTED', reason: env.browserSupport.reason ?? 'Browser family not supported.' };
	}
	// Provider rows (PROV- namespace) attest to a remote provider; without a
	// connected provider they are honestly Not configured — never silently
	// executed as emulation instead.
	const isProviderRow = String(env.envId ?? '').startsWith('PROV-')
		|| (env.executionProvider && env.executionProvider !== 'environment');
	if (isProviderRow) {
		const providerSlug = env.providerSlug ?? null;
		const connected = providerSlug
			? (providers ?? []).some((provider) => provider.slug === providerSlug && provider.connected)
			: (providers ?? []).some((provider) => provider.connected);
		if (!connected) {
			return {
				availability: 'NOT_CONFIGURED',
				reason: providerSlug
					? `Provider "${providerSlug}" not configured.`
					: 'Required execution provider not configured.'
			};
		}
	}
	// Builtin REAL_DEVICE rows (iOS/Android catalog inventory) have no local
	// execution channel; without a connected physical-device provider they are
	// honestly Not configured.
	// Builtin REAL_DEVICE rows (iOS/Android catalog inventory) have no local
	// execution channel; without a connected physical-device provider they are
	// honestly Not configured. Note: `isRealDevice` alone describes the
	// hardware the catalog row references (all iOS/Android rows carry it) —
	// SIMULATED/VIRTUAL rows execute locally, so only an explicitly requested
	// REAL_DEVICE level requires a physical provider.
	if ((env.executionLevel === 'REAL_DEVICE' || env.executionType === 'REAL_DEVICE')
		&& env.isRealDevice !== false) {
		const physicalConnected = (providers ?? []).some((provider) =>
			provider.connected && provider.kind !== 'builtin' && provider.kind !== 'catalog');
		if (!physicalConnected) {
			return {
				availability: 'NOT_CONFIGURED',
				reason: 'Physical-device provider not configured.'
			};
		}
	}
	const board = boardByEnvId.get(env.envId);
	if (board) {
		if (board.status === 'AVAILABLE') {
			return { availability: 'AVAILABLE', reason: board.unavailableReason ?? null };
		}
		if (board.status === 'BUSY') {
			// Busy is transient — still selectable; the run queues behind it.
			return { availability: 'AVAILABLE', reason: board.unavailableReason ?? null };
		}
		if (board.status === 'OFFLINE' || board.status === 'NOT_EXECUTABLE') {
			return {
				availability: 'UNAVAILABLE',
				reason: board.unavailableReason ?? `Runtime board reports ${board.status}.`
			};
		}
	}
	if (env.availability === 'OFFLINE') {
		return { availability: 'UNAVAILABLE', reason: 'Environment is inactive or offline.' };
	}
	return { availability: 'AVAILABLE', reason: null };
}

/**
 * Build one launcher configuration from an environment row.
 * `env` comes from `services.environments.list()` — already enriched with
 * execution metadata (executionLevel, browserSupport, deviceManufacturer…).
 */
export function toConfiguration(env, { boardByEnvId = new Map(), providers = [] } = {}) {
	const support = env.browserSupport ?? resolveBrowserSupportSync(env.platform, env.browserCode);
	const manufacturer = env.deviceManufacturer
		?? env.manufacturer
		?? (String(env.platform ?? '').match(/^(ios|ipados|macos)$/) ? 'Apple'
			: env.platform === 'windows' ? 'Microsoft' : null);
	const availability = availabilityFor({ ...env, browserSupport: support }, boardByEnvId, providers);
	return {
		envId: env.envId,
		device: env.device,
		manufacturer,
		platform: env.platform,
		platformLabel: env.platformLabel ?? env.platform,
		os: env.os,
		osVersion: env.osVersion,
		deviceType: env.deviceType,
		orientation: env.orientation ?? (env.deviceType === 'desktop' ? 'landscape' : 'portrait'),
		browser: env.browser,
		browserCode: env.browserCode,
		browserVersion: env.browserVersion,
		isRealDevice: Boolean(env.isRealDevice),
		executionProvider: env.executionProvider ?? 'environment',
		providerSlug: env.providerSlug ?? null,
		executionLevel: env.executionLevel ?? env.executionType ?? null,
		executionType: executionTypeFor({ ...env, browserSupport: support }),
		browserSupport: {
			status: support.status,
			reason: support.reason ?? null,
			engine: support.engine ?? null,
			branded: Boolean(support.branded),
			detectedVersion: support.detectedVersion ?? null,
			// #15162: failed launch probe → launchVerified:false; the probe
			// error travels as probeNote (run-results territory), never as
			// the availability reason.
			launchVerified: support.launchVerified !== false,
			probeNote: support.probeNote ?? null,
			provider: support.provider ?? 'local-playwright'
		},
		availability: availability.availability,
		availabilityReason: availability.reason,
		// Versions come from the catalog only (provider-supported version
		// catalogs); a branded detected version is displayed, never invented.
		versionSource: support.branded && support.detectedVersion ? 'local-registry' : 'catalog'
	};
}

/**
 * The seven browser families, always all of them — unavailable families stay
 * visible with a clear reason and are never selectable.
 */
export function browserFamilies({ supportByCode = {}, platformsByCode = null } = {}) {
	const platformsByCodeResolved = platformsByCode ?? Object.fromEntries(
		BROWSERS.map((browser) => [browser.code, browser.platforms])
	);
	return FAMILY_ORDER.map((code) => {
		const definition = BROWSERS.find((browser) => browser.code === code);
		const support = supportByCode[code] ?? {};
		const notSupported = support.status === 'not_supported' || support.status === undefined;
		return {
			code,
			label: definition?.name ?? code,
			platforms: platformsByCodeResolved[code] ?? [],
			channels: definition?.channels ?? ['stable'],
			note: definition?.note ?? null,
			availableOnAnyPlatform: !notSupported,
			reasonWhenUnavailable: notSupported
				? (support.reason ?? definition?.note ?? 'Browser family is not supported by any configured provider.')
				: null
		};
	});
}

/** Filter configurations across the launcher facets. */
export function filterConfigurations(configurations, filters = {}) {
	const term = filters.search ? String(filters.search).toLowerCase() : '';
	return configurations.filter((configuration) => {
		if (filters.platform && configuration.platform !== filters.platform) return false;
		if (filters.manufacturer && configuration.manufacturer !== filters.manufacturer) return false;
		if (filters.device && configuration.device !== filters.device) return false;
		if (filters.osVersion && configuration.osVersion !== filters.osVersion) return false;
		if (filters.browser && configuration.browser !== filters.browser) return false;
		if (filters.browserCode && configuration.browserCode !== filters.browserCode) return false;
		if (filters.browserVersion && configuration.browserVersion !== String(filters.browserVersion)) return false;
		if (filters.deviceType && configuration.deviceType !== filters.deviceType) return false;
		if (filters.orientation && configuration.orientation !== filters.orientation) return false;
		if (filters.executionType && configuration.executionType !== filters.executionType) return false;
		if (term) {
			const haystack = [
				configuration.envId,
				configuration.device,
				configuration.manufacturer,
				configuration.browser,
				configuration.os,
				configuration.osVersion
			].filter(Boolean).join(' ').toLowerCase();
			if (!haystack.includes(term)) return false;
		}
		return true;
	});
}

/**
 * Assemble the full launcher response.
 *
 * @param {object} options
 * @param {Array} options.environments   enriched environment rows (active only, caller's responsibility)
 * @param {Array} [options.providers]    catalog providers from catalogProviderMeta()
 * @param {Array} [options.board]        runtime board rows (deviceBoard())
 * @param {object} [options.filters]     facet filters
 * @param {number} [options.limit]       pagination limit (default 80000 — the launcher fetches everything once)
 * @param {number} [options.offset]      pagination offset
 */
export function assembleQaConfigurations(options = {}) {
	const {
		environments = [],
		providers = [],
		board = [],
		filters = {},
		limit = 80000,
		offset = 0
	} = options;
	const boardByEnvId = new Map(board.map((row) => [row.envId, row]));
	const all = environments.map((env) => toConfiguration(env, { boardByEnvId, providers }));
	const filtered = filterConfigurations(all, filters);
	const total = filtered.length;
	const configurations = filtered.slice(offset, offset + limit);

	// Family support snapshot across the ACTIVE set (a family counts as
	// available when at least one configuration on some platform can execute).
	const supportByCode = {};
	for (const code of FAMILY_ORDER) {
		const executable = filtered.some((configuration) =>
			configuration.browserCode === code && configuration.availability !== 'NOT_SUPPORTED');
		const anyRow = filtered.find((configuration) => configuration.browserCode === code);
		supportByCode[code] = executable
			? { status: anyRow?.browserSupport.status ?? 'supported' }
			: { status: 'not_supported', reason: anyRow?.browserSupport.reason ?? null };
	}

	const totals = {
		configurations: total,
		// Totals are HONEST: over the full filtered set, not the paginated
		// slice, so the launcher summary matches the catalog even at limit=200.
		available: filtered.filter((configuration) => configuration.availability === 'AVAILABLE').length,
		unavailable: filtered.filter((configuration) => configuration.availability !== 'AVAILABLE').length
	};
	return {
		configurations,
		browserFamilies: browserFamilies({ supportByCode }),
		providers,
		totals: { ...totals, filteredOut: all.length - total },
		pagination: { offset, limit, total }
	};
}

/**
 * Convenience for route wiring: required services are injected so tests can
 * pass fakes. Degrades honestly — a failing environment store surfaces as an
 * error, never an empty catalog pretending everything is fine. Filters and
 * pagination are applied to the assembled configurations (facet filtering
 * happens post-join, so provider/board rows participate).
 */
export async function buildQaConfigurations(
	{ environmentsService, providers = [], board = [], limit = 200, offset = 0, index = false } = {},
	filters = {}
) {
	const rows = await environmentsService.list({ active: 'true', limit: 80000 });
	const assembled = assembleQaConfigurations({ environments: rows, providers, board, filters, limit, offset });
	if (!index) return assembled;
	// Compact full-catalog index: the launcher uses it for selection math,
	// family counts and facets while the tree renders windowed slices only.
	const full = assembleQaConfigurations({ environments: rows, providers, board, filters, limit: 80000, offset: 0 });
	const indexRows = full.configurations.map((configuration) => ({
		envId: configuration.envId,
		platform: configuration.platform,
		manufacturer: configuration.manufacturer,
		device: configuration.device,
		deviceType: configuration.deviceType,
		orientation: configuration.orientation,
		os: configuration.os,
		osVersion: configuration.osVersion,
		browser: configuration.browser,
		browserCode: configuration.browserCode,
		browserVersion: configuration.browserVersion,
		executionType: configuration.executionType,
		availability: configuration.availability,
		availabilityReason: configuration.availabilityReason
	}));
	const pageSize = Math.max(1, Math.min(Number(limit) || 1, 80000));
	return {
		...assembled,
		configurations: indexRows.slice(offset, offset + pageSize),
		index: indexRows,
		totals: full.totals
	};
}

/**
 * Canonical platform order for the device tree — Apple iPhone, Apple iPad,
 * Apple Mac, Android, Windows. Anything unknown sorts after these.
 */
const DEVICE_TREE_PLATFORM_ORDER = ['ios', 'ipados', 'macos', 'android', 'windows'];

/**
 * Device-grouped window for the launcher device tree (#15439 Issue 2).
 *
 * Raw row pagination (limit=200&offset=N) sliced the 38k-row catalog in
 * envId order, so the first window was 200 rows of ONE Android device —
 * the checklist showed "two devices" and "Android" was the only platform
 * group until the user clicked "Load more" dozens of times.
 *
 * Instead, group the filtered configurations by (manufacturer, platform,
 * device), sort the DEVICE groups in the canonical platform order, and
 * return ALL rows of the `limit` device groups starting at group `offset`.
 * One window now spans every platform family; "Load more" appends the next
 * batch of DEVICES, not the next 200 rows of the first device.
 *
 * Response shape: { configurations, deviceGroups, total, hasMore } where
 * `deviceGroups` counts DEVICE groups (for "Load more" math) and `total`
 * still counts rows (summary honesty).
 */
export async function buildQaConfigurationsByDevice(
	{ environmentsService, providers = [], board = [], limit = 12, offset = 0 } = {},
	filters = {}
) {
	const rows = await environmentsService.list({ active: 'true', limit: 80000 });
	const full = assembleQaConfigurations({ environments: rows, providers, board, filters, limit: 80000, offset: 0 });
	const filtered = full.configurations;

	const groups = new Map();
	for (const configuration of filtered) {
		const key = `${configuration.manufacturer ?? ''}|${configuration.platform}|${configuration.device}`;
		let entry = groups.get(key);
		if (!entry) {
			entry = { key, platform: configuration.platform, device: configuration.device, manufacturer: configuration.manufacturer ?? '', rows: [] };
			groups.set(key, entry);
		}
		entry.rows.push(configuration);
	}
	const ordered = [...groups.values()].sort((a, b) => {
		const pa = DEVICE_TREE_PLATFORM_ORDER.indexOf(a.platform);
		const pb = DEVICE_TREE_PLATFORM_ORDER.indexOf(b.platform);
		if (pa !== pb) return (pa === -1 ? DEVICE_TREE_PLATFORM_ORDER.length : pa) - (pb === -1 ? DEVICE_TREE_PLATFORM_ORDER.length : pb);
		return a.key.localeCompare(b.key);
	});

	// #15439 Issue 2: the FIRST window must show every platform category.
	// Round-robin the platform-ordered device lists (ios → ipados → macos →
	// android → windows, repeating) so each window mixes platforms instead
	// of serving 12 iPhones before a single Android appears. "Load more"
	// walks this interleaved order.
	const byPlatform = new Map(DEVICE_TREE_PLATFORM_ORDER.map((id) => [id, []]));
	const unknownPlatform = [];
	for (const entry of ordered) {
		(byPlatform.get(entry.platform) ?? unknownPlatform).push(entry);
	}
	const interleaved = [];
	const queues = [...byPlatform.values()].filter((list) => list.length > 0);
	if (unknownPlatform.length > 0) queues.push(unknownPlatform);
	while (queues.some((queue) => queue.length > 0)) {
		for (const queue of queues) {
			const entry = queue.shift();
			if (entry) interleaved.push(entry);
		}
	}

	const slice = interleaved.slice(offset, offset + Math.max(1, limit));
	return {
		configurations: slice.flatMap((entry) => entry.rows),
		deviceGroups: interleaved.length,
		deviceOffset: offset,
		deviceLimit: Math.max(1, limit),
		hasMore: offset + slice.length < interleaved.length,
		browserFamilies: full.browserFamilies,
		providers: full.providers,
		totals: full.totals
	};
}
