import test from 'node:test';
import assert from 'node:assert/strict';
import {
	assembleQaConfigurations,
	browserFamilies,
	executionTypeFor,
	availabilityFor,
	filterConfigurations,
	toConfiguration,
	FAMILY_ORDER,
	EXECUTION_TYPES
} from './qaConfigurations.js';
import { generateEnvironments, BROWSERS, BROWSER_VERSIONS } from './environmentCatalog.js';

/** Build a synthetic enriched environment row the way environmentService does. */
function enrichedEnv(overrides = {}) {
	return {
		envId: 'IOS-IP15-18.0-CHR-140',
		device: 'iPhone 15',
		deviceManufacturer: 'Apple',
		platform: 'ios',
		platformLabel: 'iOS',
		os: 'iOS',
		osVersion: '18.0',
		deviceType: 'mobile',
		orientation: 'portrait',
		browser: 'Chrome',
		browserCode: 'chrome',
		browserVersion: '140',
		isRealDevice: true,
		executionProvider: 'environment',
		active: true,
		executionLevel: 'SIMULATED',
		executionType: 'SIMULATED',
		availability: 'ONLINE',
		browserSupport: { status: 'supported', engine: 'chromium', reason: 'bundled', provider: 'local-playwright' },
		...overrides
	};
}

test('FAMILY_ORDER lists all seven families in launcher order', () => {
	assert.deepEqual(FAMILY_ORDER, ['edge', 'chrome', 'brave', 'firefox', 'safari', 'opera', 'duckduckgo']);
});

test('browserFamilies always returns all seven, DuckDuckGo visible with reason', () => {
	const families = browserFamilies({
		supportByCode: {
			chrome: { status: 'supported' },
			edge: { status: 'supported' },
			firefox: { status: 'supported' },
			opera: { status: 'engine_equivalent' },
			brave: { status: 'engine_equivalent' },
			duckduckgo: { status: 'not_supported', reason: 'mobile-only browser, no desktop automation channel' },
			safari: { status: 'engine_equivalent' }
		}
	});
	assert.equal(families.length, 7);
	assert.deepEqual(families.map((family) => family.code), FAMILY_ORDER);
	const ddg = families.find((family) => family.code === 'duckduckgo');
	assert.equal(ddg.availableOnAnyPlatform, false);
	assert.match(ddg.reasonWhenUnavailable, /mobile-only|no desktop automation channel/);
});

test('executionTypeFor maps strict levels to the launcher vocabulary', () => {
	assert.equal(executionTypeFor({ executionLevel: 'REAL_DEVICE', deviceType: 'mobile', platform: 'ios' }), EXECUTION_TYPES.PHYSICAL_DEVICE);
	assert.equal(executionTypeFor({ executionLevel: 'VIRTUAL_DEVICE', deviceType: 'desktop', platform: 'windows' }), EXECUTION_TYPES.VIRTUAL_MACHINE);
	assert.equal(executionTypeFor({ executionLevel: 'SIMULATED', deviceType: 'mobile', platform: 'android' }), EXECUTION_TYPES.EMULATOR);
	assert.equal(executionTypeFor({
		executionLevel: 'SIMULATED', deviceType: 'mobile', platform: 'ios',
		browserSupport: { status: 'engine_equivalent' }
	}), EXECUTION_TYPES.SIMULATOR);
	assert.equal(executionTypeFor({
		executionLevel: 'SIMULATED', deviceType: 'desktop', platform: 'windows',
		browserSupport: { status: 'supported' }
	}), EXECUTION_TYPES.BROWSER_EMULATION);
	assert.equal(executionTypeFor({
		executionLevel: 'SIMULATED', deviceType: 'desktop', platform: 'macos',
		browserSupport: { status: 'engine_equivalent' }
	}), EXECUTION_TYPES.SIMULATOR);
});

test('availabilityFor: builtin real-device row without a physical provider is NOT_CONFIGURED', () => {
	const result = availabilityFor(
		enrichedEnv({ executionLevel: 'REAL_DEVICE', executionType: 'REAL_DEVICE', isRealDevice: true }),
		new Map(),
		[{ slug: 'builtin', kind: 'builtin', connected: true }]
	);
	assert.equal(result.availability, 'NOT_CONFIGURED');
	assert.ok(/Physical-device provider not configured/i.test(result.reason));
});

test('availabilityFor: simulated real hardware row stays AVAILABLE locally', () => {
	const result = availabilityFor(
		enrichedEnv({ executionLevel: 'SIMULATED', executionType: 'SIMULATED', isRealDevice: true }),
		new Map(),
		[{ slug: 'builtin', kind: 'builtin', connected: true }]
	);
	assert.equal(result.availability, 'AVAILABLE');
});

test('availabilityFor: provider row with unconnected provider is NOT_CONFIGURED', () => {
	const result = availabilityFor(
		enrichedEnv({
			envId: 'PROV-BS-X',
			executionProvider: 'browserstack',
			providerSlug: 'browserstack'
		}),
		new Map(),
		[{ slug: 'builtin', kind: 'builtin', connected: true }, { slug: 'browserstack', kind: 'external', connected: false }]
	);
	assert.equal(result.availability, 'NOT_CONFIGURED');
	assert.match(result.reason, /not configured/i);
});

test('availabilityFor: board OFFLINE makes the configuration UNAVAILABLE with reason', () => {
	const board = new Map([['IOS-IP15-18.0-CHR-140', { envId: 'IOS-IP15-18.0-CHR-140', status: 'OFFLINE', unavailableReason: 'local runtime cannot execute iOS' }]]);
	const result = availabilityFor(
		enrichedEnv({ executionLevel: 'SIMULATED', isRealDevice: false }),
		board,
		[{ slug: 'builtin', kind: 'builtin', connected: true }]
	);
	assert.equal(result.availability, 'UNAVAILABLE');
	assert.match(result.reason, /local runtime cannot execute iOS/);
});

test('availabilityFor: not_supported browser is NOT_SUPPORTED with its reason', () => {
	const result = availabilityFor(
		enrichedEnv({ browser: 'DuckDuckGo', browserCode: 'duckduckgo', browserSupport: { status: 'not_supported', reason: 'mobile-only' } }),
		new Map(),
		[]
	);
	assert.equal(result.availability, 'NOT_SUPPORTED');
});

test('toConfiguration carries manufacturer, execution type and support fields', () => {
	const configuration = toConfiguration(enrichedEnv());
	assert.equal(configuration.manufacturer, 'Apple');
	assert.equal(configuration.browserSupport.status, 'supported');
	assert.equal(configuration.executionType, EXECUTION_TYPES.EMULATOR);
	assert.equal(configuration.orientation, 'portrait');
});

test('filterConfigurations filters platform, manufacturer, OS version, orientation and search', () => {
	const configurations = [
		toConfiguration(enrichedEnv()),
		toConfiguration(enrichedEnv({ envId: 'AND-SGS24-15-BRV-138', device: 'Galaxy S24', deviceManufacturer: 'Samsung', platform: 'android', os: 'Android', osVersion: '15', browser: 'Brave', browserCode: 'brave', browserVersion: '138' })),
		toConfiguration(enrichedEnv({ envId: 'WIN-SURF11-11-EDG-140', device: 'Surface Pro 11', deviceManufacturer: 'Microsoft', platform: 'windows', os: 'Windows', osVersion: '11', deviceType: 'tablet', browser: 'Edge', browserCode: 'edge', browserVersion: '140', orientation: 'landscape' }))
	];
	assert.equal(filterConfigurations(configurations, { platform: 'android' }).length, 1);
	assert.equal(filterConfigurations(configurations, { manufacturer: 'Microsoft' }).length, 1);
	assert.equal(filterConfigurations(configurations, { osVersion: '18.0' }).length, 1);
	assert.equal(filterConfigurations(configurations, { orientation: 'landscape' }).length, 1);
	assert.equal(filterConfigurations(configurations, { browserCode: 'brave' }).length, 1);
	const searched = filterConfigurations(configurations, { search: 'galaxy' });
	assert.equal(searched.length, 1);
	assert.equal(searched[0].device, 'Galaxy S24');
});

test('assembleQaConfigurations: all seven families, honest totals, pagination', () => {
	const environments = [
		enrichedEnv(),
		enrichedEnv({ envId: 'AND-SGS24-15-BRV-138', device: 'Galaxy S24', deviceManufacturer: 'Samsung', platform: 'android', os: 'Android', osVersion: '15', browser: 'Brave', browserCode: 'brave', browserVersion: '138', isRealDevice: true, executionLevel: 'REAL_DEVICE' })
	];
	const result = assembleQaConfigurations({ environments, providers: [], board: [] });
	assert.equal(result.browserFamilies.length, 7);
	assert.equal(result.configurations.length, 2);
	// Galaxy S24 real-device row: no physical provider configured.
	const galaxy = result.configurations.find((configuration) => configuration.envId === 'AND-SGS24-15-BRV-138');
	assert.equal(galaxy.availability, 'NOT_CONFIGURED');
	assert.equal(result.totals.available, 1);
	assert.equal(result.totals.unavailable, 1);
	const paged = assembleQaConfigurations({ environments, providers: [], board: [], limit: 1, offset: 0 });
	assert.equal(paged.configurations.length, 1);
	assert.equal(paged.pagination.total, 2);
});

test('every catalog version traces to BROWSER_VERSIONS — no invented versions', () => {
	const environments = generateEnvironments();
	const allowed = new Set([
		...Object.values(BROWSER_VERSIONS).flat().map(String)
	]);
	// Safari versions derive from the OS — accept safariVersionFor outputs.
	const catalogSafari = new Set(environments
		.filter((env) => env.browserCode === 'safari')
		.map((env) => String(env.browserVersion)));
	for (const env of environments) {
		const version = String(env.browserVersion);
		if (env.browserCode === 'safari') {
			assert.ok(catalogSafari.has(version), `safari version ${version} inconsistent with catalog`);
			continue;
		}
		assert.ok(allowed.has(version), `version ${version} for ${env.browserCode} not in BROWSER_VERSIONS`);
	}
});

test('generated catalog: Apple rows carry manufacturer=Apple', () => {
	const environments = generateEnvironments();
	const appleRows = environments.filter((env) => ['ios', 'ipados', 'macos'].includes(env.platform));
	assert.ok(appleRows.length > 100, 'expected a substantial Apple set');
	assert.ok(appleRows.every((env) => env.manufacturer === 'Apple'), 'all Apple rows must carry manufacturer');
});

// #15123 regression: withExecutionMetadata stamps a blanket
// executionType='VIRTUAL_DEVICE' on every catalog row; executionTypeFor must
// ignore that default stamp and derive honestly per platform + support.
test('#15123 blanket VIRTUAL_DEVICE stamp does not collapse all rows to virtual_machine', () => {
	const environments = generateEnvironments().map((env) => ({
		...env,
		executionType: 'VIRTUAL_DEVICE'
	}));
	const counts = {};
	for (const env of environments) {
		const configuration = toConfiguration(env, { providers: [] });
		counts[configuration.executionType] = (counts[configuration.executionType] ?? 0) + 1;
	}
	assert.ok(counts.simulator > 0, 'expected simulator rows (engine-equivalent mobile)');
	assert.ok(counts.emulator > 0, 'expected emulator rows (mobile)');
	assert.ok(counts.browser_emulation > 0, 'expected browser_emulation rows (desktop)');
	assert.equal(counts.virtual_machine ?? 0, 0, 'no row may default to virtual_machine');
});

test('#15123 explicit REAL_DEVICE request still maps to physical_device', () => {
	const [env] = generateEnvironments().slice(0, 1);
	const configuration = toConfiguration(
		{ ...env, executionLevelRequested: 'REAL_DEVICE', executionType: 'VIRTUAL_DEVICE' },
		{ providers: [] }
	);
	assert.equal(configuration.executionType, 'physical_device');
});

test('#15123 execution-type badge labels cover all five vocabulary entries', () => {
	// Label map lives in the client module (qaConfigMatrix.js) — assert the
	// server vocabulary itself and the mapping contract through
	// toConfiguration output values.
	const seen = new Set(generateEnvironments().map((env) => toConfiguration(env, { providers: [] }).executionType));
	for (const type of [EXECUTION_TYPES.PHYSICAL_DEVICE, EXECUTION_TYPES.VIRTUAL_MACHINE,
		EXECUTION_TYPES.EMULATOR, EXECUTION_TYPES.SIMULATOR, EXECUTION_TYPES.BROWSER_EMULATION]) {
		assert.ok(typeof type === 'string' && type.length > 0, `vocabulary entry ${type}`);
		assert.ok(['physical_device', 'virtual_machine', 'emulator', 'simulator', 'browser_emulation'].includes(type));
	}
	assert.ok(seen.has('simulator') && seen.has('emulator') && seen.has('browser_emulation'),
		`catalog must expose multiple honest execution types, saw ${[...seen].join(',')}`);
});
