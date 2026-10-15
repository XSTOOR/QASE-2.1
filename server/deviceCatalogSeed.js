import {
	APPLE_DEVICES,
	ANDROID_DEVICES,
	WINDOWS_DEVICES,
	BROWSERS,
	BROWSER_VERSIONS,
	PLATFORMS
} from './environmentCatalog.js';

/**
 * Seed data builder for the DB-backed device/OS/browser catalog (migration 016).
 *
 * The frozen module (environmentCatalog.js) remains the seed source; this module
 * turns it into rows for the global catalog tables. Deterministic natural keys
 * (slugs, codes, version strings) are used as ids so seeding is idempotent.
 */

// ---------------------------------------------------------------------------
// Hardware / chips
// ---------------------------------------------------------------------------

const HARDWARE = [
	{ id: 'm1', display_name: 'Apple M1' },
	{ id: 'm2', display_name: 'Apple M2' },
	{ id: 'm3', display_name: 'Apple M3' },
	{ id: 'm4', display_name: 'Apple M4' },
	{ id: 'm5', display_name: 'Apple M5' },
	{ id: 'a9', display_name: 'Apple A9' },
	{ id: 'a10', display_name: 'Apple A10 Fusion' },
	{ id: 'a11', display_name: 'Apple A11 Bionic' },
	{ id: 'a12', display_name: 'Apple A12 Bionic' },
	{ id: 'a13', display_name: 'Apple A13 Bionic' },
	{ id: 'a14', display_name: 'Apple A14 Bionic' },
	{ id: 'a15', display_name: 'Apple A15 Bionic' },
	{ id: 'a16', display_name: 'Apple A16 Bionic' },
	{ id: 'a17pro', display_name: 'Apple A17 Pro' },
	{ id: 'a18', display_name: 'Apple A18' },
	{ id: 'a18pro', display_name: 'Apple A18 Pro' },
	{ id: 'a19', display_name: 'Apple A19' }
];

/** Chip per device model slug (longest-prefix match wins). */
const MODEL_CHIP_RULES = [
	['IP11PRO', 'a13'], ['IP11PROMAX', 'a13'], ['IP11', 'a13'],
	['IP12PRO', 'a14'], ['IP12PROMAX', 'a14'], ['IP12MINI', 'a14'], ['IP12', 'a14'],
	['IP13PRO', 'a15'], ['IP13PROMAX', 'a15'], ['IP13MINI', 'a15'], ['IP13', 'a15'],
	['IP14PRO', 'a16'], ['IP14PROMAX', 'a16'], ['IP14PLUS', 'a15'], ['IP14', 'a15'],
	['IP15PRO', 'a17pro'], ['IP15PROMAX', 'a17pro'], ['IP15PLUS', 'a16'], ['IP15', 'a16'],
	['IP16PRO', 'a18pro'], ['IP16PROMAX', 'a18pro'], ['IP16E', 'a18'], ['IP16', 'a18'],
	['IP17PRO', 'a19'], ['IP17PROMAX', 'a19'], ['IP17AIR', 'a19'], ['IP17', 'a19'],
	// 2027.01.0 (#14273) legacy iPhone chips: A10 (7/8/X), A12 (XR/XS),
	// SE gens reuse the iPhone-body chips (1st A9→null kept honest as a13 floor? No —
	// A9 chip id absent from HARDWARE, so SE1 maps null; SE2 A13; SE3 A15).
	['IPXSMAX', 'a12'], ['IPXS', 'a12'], ['IPXR', 'a12'],
	['IP8PLUS', 'a11'], ['IP8', 'a11'], ['IPX', 'a11'],
	['IP7PLUS', 'a10'], ['IP7', 'a10'],
	['IPSE3', 'a15'], ['IPSE2', 'a13'], ['IPSE1', null],
	// 2027.02.0 (#14420) MacBook 13-inch Apple Silicon + iMac 24 M1
	['MACMBA-M1', 'm1'], ['MACMBP13-M1', 'm1'], ['MACMBP13-M2', 'm2'], ['MACIMAC24-M1', 'm1'],
	// 2027.01.0 (#14273) iPad generations (longest prefix first)
	['IPADPRO13', 'm4'], ['IPADPRO129-6', 'm2'], ['IPADPRO129-5', 'm1'], ['IPADPRO129', 'm1'],
	['IPADPRO11-5', 'm4'], ['IPADPRO11-4', 'm2'], ['IPADPRO11-3', 'm2'], ['IPADPRO11-2', 'm1'], ['IPADPRO11', 'm1'],
	['IPADAIR7', 'm3'], ['IPADAIR6', 'm2'], ['IPADAIR5', 'm1'], ['IPADAIR4', 'a14'], ['IPADAIR3', 'a12'],
	['IPADMINI7', 'a17pro'], ['IPADMINI6', 'a15'], ['IPADMINI5', 'a12'],
	['IPAD11', 'a16'], ['IPAD10', 'a14'], ['IPAD9', 'a13'], ['IPAD8', 'a12'], ['IPAD7', 'a10'], ['IPAD6', 'a10'], ['IPAD5', 'a9'],
	['IPAD', 'a14']
];

function chipForSlug(slug) {
	for (const [prefix, chip] of MODEL_CHIP_RULES) {
		if (slug.startsWith(prefix)) return chip;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

function deviceCategoryRows() {
	return [
		{ id: 'iphone', display_name: 'iPhone', device_type: 'mobile', platform: 'ios', sort_order: 0 },
		{ id: 'ipad', display_name: 'iPad', device_type: 'tablet', platform: 'ipados', sort_order: 1 },
		{ id: 'mac', display_name: 'Mac', device_type: 'desktop', platform: 'macos', sort_order: 2 },
		// Android manufacturers (Phase 9) — one category per manufacturer keeps the
		// category → model drill-down natural for the UI.
		{ id: 'samsung', display_name: 'Samsung', device_type: 'mobile', platform: 'android', sort_order: 10 },
		{ id: 'google-pixel', display_name: 'Google Pixel', device_type: 'mobile', platform: 'android', sort_order: 11 },
		{ id: 'oneplus', display_name: 'OnePlus', device_type: 'mobile', platform: 'android', sort_order: 12 },
		{ id: 'motorola', display_name: 'Motorola', device_type: 'mobile', platform: 'android', sort_order: 13 },
		{ id: 'xiaomi', display_name: 'Xiaomi', device_type: 'mobile', platform: 'android', sort_order: 14 },
		{ id: 'redmi', display_name: 'Redmi', device_type: 'mobile', platform: 'android', sort_order: 15 },
		{ id: 'oppo', display_name: 'Oppo', device_type: 'mobile', platform: 'android', sort_order: 16 },
		{ id: 'vivo', display_name: 'Vivo', device_type: 'mobile', platform: 'android', sort_order: 17 },
		{ id: 'realme', display_name: 'Realme', device_type: 'mobile', platform: 'android', sort_order: 18 },
		{ id: 'nothing', display_name: 'Nothing', device_type: 'mobile', platform: 'android', sort_order: 19 },
		// 2027.01.0 (#14273) new manufacturers
		{ id: 'poco', display_name: 'POCO', device_type: 'mobile', platform: 'android', sort_order: 21 },
		{ id: 'sony', display_name: 'Sony', device_type: 'mobile', platform: 'android', sort_order: 22 },
		{ id: 'asus', display_name: 'Asus', device_type: 'mobile', platform: 'android', sort_order: 23 },
		{ id: 'lenovo', display_name: 'Lenovo', device_type: 'tablet', platform: 'android', sort_order: 24 },
		{ id: 'huawei', display_name: 'Huawei', device_type: 'mobile', platform: 'android', sort_order: 25 },
		{ id: 'honor', display_name: 'Honor', device_type: 'mobile', platform: 'android', sort_order: 26 },
		{ id: 'other-android', display_name: 'Other Android devices', device_type: 'mobile', platform: 'android', sort_order: 20 },
		// Windows form factors
		{ id: 'windows-laptop', display_name: 'Windows Laptop', device_type: 'desktop', platform: 'windows', sort_order: 30 },
		{ id: 'windows-desktop', display_name: 'Windows Desktop', device_type: 'desktop', platform: 'windows', sort_order: 31 },
		{ id: 'windows-tablet', display_name: 'Windows Tablet', device_type: 'tablet', platform: 'windows', sort_order: 32 },
		{ id: 'windows-2in1', display_name: 'Windows 2-in-1', device_type: 'tablet', platform: 'windows', sort_order: 33 }
	];
}

function osFamilyRows() {
	return PLATFORMS.map((platform, index) => ({
		id: platform.id,
		display_name: platform.os,
		env_code: platform.envCode,
		sort_order: index
	}));
}

const MACOS_CHRONOLOGICAL = ['High Sierra', 'Mojave', 'Catalina', 'Big Sur', 'Monterey', 'Ventura', 'Sonoma', 'Sequoia', 'Tahoe'];

function osVersionRows() {
	const rows = [];
	const seen = new Set();
	const push = (platformId, version) => {
		const key = `${platformId}|${version}`;
		if (seen.has(key)) return;
		seen.add(key);
		const family = PLATFORMS.find((p) => p.id === platformId);
		rows.push({
			id: osVersionId(platformId, version),
			os_family_id: platformId,
			version,
			display: `${family.os} ${version}`,
			major: majorOf(version),
			sort_key: sortKeyOf(version, platformId)
		});
	};
	for (const device of APPLE_DEVICES) {
		for (const osVersion of device.osVersions) push(device.platformId, osVersion);
	}
	// Android 11–16 (Phase 9) — every Android OS version is addressable even if
	// no seeded device uses it yet (future devices can adopt them data-only).
	for (const version of ['11', '12', '13', '14', '15', '16']) push('android', version);
	// Windows 7–11 (2027.01.0 #14273): every Windows OS version addressable.
	for (const version of ['7', '8', '8.1', '10', '11']) push('windows', version);
	return rows;
}

function majorOf(version) {
	const match = /^(\d+)/.exec(String(version).trim());
	return match ? match[1] : String(version);
}

function sortKeyOf(version, familyId) {
	if (familyId === 'macos') {
		const index = MACOS_CHRONOLOGICAL.indexOf(String(version));
		return String(index >= 0 ? index : 99).padStart(2, '0');
	}
	const parts = String(version).split('.').map((part) => Number(part) || 0);
	return `${String(parts[0] ?? 0).padStart(3, '0')}.${String(parts[1] ?? 0).padStart(3, '0')}`;
}

function deviceGenerationRows() {
	// Generations are added through the admin API for Mac/iPad lines once those
	// models exist as rows (the 015 seed collapses macOS to one device per OS
	// version). The seed returns an empty list — an intentional, documented
	// placeholder that keeps buildCatalogSeed's shape stable.
	return [];
}

const ANDROID_MANUFACTURER_CATEGORY = {
	'Samsung': 'samsung', 'Google': 'google-pixel', 'OnePlus': 'oneplus', 'Motorola': 'motorola',
	'Xiaomi': 'xiaomi', 'Oppo': 'oppo', 'Vivo': 'vivo', 'Realme': 'realme', 'Nothing': 'nothing',
	// 2027.01.0 (#14273)
	'POCO': 'poco', 'Sony': 'sony', 'Asus': 'asus', 'Lenovo': 'lenovo', 'Huawei': 'huawei', 'Honor': 'honor'
};

function deviceModelRows() {
	const appleRows = APPLE_DEVICES.map((device) => ({
		id: device.slug, // natural key as PK — deterministic, idempotent
		category_id: device.platformId === 'ios' ? 'iphone' : device.platformId === 'ipados' ? 'ipad' : 'mac',
		display_name: device.name,
		slug: device.slug,
		browserstack_device_name: device.browserstackDeviceName,
		screen_size: device.screenSize,
		screen_resolution: device.emulation?.viewport
			? `${device.emulation.viewport.width}x${device.emulation.viewport.height}`
			: null,
		is_real_device: device.isRealDevice,
		hardware_id: chipForSlug(device.slug)
	}));
	const androidRows = ANDROID_DEVICES.map((device) => ({
		id: device.slug,
		category_id: ANDROID_MANUFACTURER_CATEGORY[device.manufacturer] ?? 'other-android',
		display_name: device.name,
		slug: device.slug,
		browserstack_device_name: device.browserstackDeviceName,
		screen_size: device.screenSize,
		screen_resolution: device.emulation?.viewport
			? `${device.emulation.viewport.width}x${device.emulation.viewport.height}`
			: null,
		is_real_device: device.isRealDevice,
		hardware_id: null
	}));
	const windowsRows = WINDOWS_DEVICES.map((device) => ({
		id: device.slug,
		// 2027.01.0 (#14273): form-factor categories incl. 2-in-1
		category_id: device.deviceType === 'two-in-one'
			? 'windows-2in1'
			: `windows-${device.deviceType === 'tablet' ? 'tablet' : device.name.includes('Laptop') ? 'laptop' : 'desktop'}`,
		display_name: device.name,
		slug: device.slug,
		browserstack_device_name: null,
		screen_size: device.screenSize,
		screen_resolution: device.emulation?.viewport
			? `${device.emulation.viewport.width}x${device.emulation.viewport.height}`
			: null,
		is_real_device: device.isRealDevice,
		hardware_id: null
	}));
	return [...appleRows, ...androidRows, ...windowsRows];
}

function deviceOsCompatibilityRows() {
	const rows = [];
	for (const device of [...APPLE_DEVICES, ...ANDROID_DEVICES, ...WINDOWS_DEVICES]) {
		for (const osVersion of device.osVersions) {
			rows.push({ device_model_id: device.slug, os_version_id: osVersionId(device.platformId, osVersion) });
		}
	}
	return rows;
}

/** Natural key for an OS version row: `ios:18.3` / `macos:Sonoma`. */
export function osVersionId(familyId, version) {
	return `${familyId}:${version}`;
}

function browserRows() {
	return BROWSERS.map((browser, index) => ({
		id: browser.code,
		display_name: browser.name,
		env_code: browser.envCode,
		independently_versioned: Boolean(browser.independentlyVersioned),
		sort_order: index
	}));
}

function browserVersionRows() {
	const rows = [];
	for (const [browserId, versions] of Object.entries(BROWSER_VERSIONS)) {
		for (const version of versions) {
			rows.push({
				id: `${browserId}:${version}`,
				browser_id: browserId,
				version: String(version),
				sort_key: String(version).padStart(6, '0')
			});
		}
	}
	return rows;
}

function browserPlatformSupportRows() {
	const rows = [];
	const PLATFORM_SET = ['ios', 'ipados', 'macos', 'android', 'windows'];
	for (const browser of BROWSERS) {
		for (const platform of PLATFORM_SET) {
			rows.push({
				browser_id: browser.code,
				platform,
				supported: browser.platforms.includes(platform)
			});
		}
	}
	return rows;
}

export function buildCatalogSeed() {
	return {
		deviceCategories: deviceCategoryRows(),
		hardware: HARDWARE.map((chip, index) => ({ ...chip, sort_order: index })),
		deviceModels: deviceModelRows(),
		deviceGenerations: deviceGenerationRows(),
		osFamilies: osFamilyRows(),
		osVersions: osVersionRows(),
		deviceOsCompatibility: deviceOsCompatibilityRows(),
		browsers: browserRows(),
		browserVersions: browserVersionRows(),
		browserPlatformSupport: browserPlatformSupportRows()
	};
}
