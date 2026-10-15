import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildCatalogSeed, osVersionId } from './deviceCatalogSeed.js';

/**
 * Local JSON file backend for the device/OS/browser catalog (migration 016
 * equivalent). Same contract as createPostgresDeviceCatalogRepository:
 * seed (idempotent), list(filters), create (upsert by natural key),
 * isCombinationSupported (data-driven).
 *
 * State lives in .qase/device-catalog.json — mirrors the environments store
 * conventions (atomic tmp-file rename, mode 0600). Admin-added rows are never
 * removed by re-seeding.
 */

export function createLocalDeviceCatalogBackend(options = {}) {
	const stateDir = options.stateDir ?? path.join(process.cwd(), '.qase');
	const stateFile = options.stateFile ?? path.join(stateDir, 'device-catalog.json');
	/** @type {Map<string, any[]>} entity name -> rows */
	const tables = new Map();
	let loaded = false;

	function loadFromDisk() {
		if (loaded) return;
		loaded = true;
		try {
			const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
			for (const [entity, rows] of Object.entries(parsed)) {
				if (Array.isArray(rows)) tables.set(entity, rows);
			}
		} catch {
			/* first boot — seed below recreates it */
		}
	}

	function persistNow() {
		try {
			fs.mkdirSync(stateDir, { recursive: true });
			const tmp = `${stateFile}.tmp-${process.pid}`;
			fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(tables), undefined, '\t'), { mode: 0o600 });
			fs.renameSync(tmp, stateFile);
		} catch {
			/* a dashboard that cannot write its catalog file is still usable */
		}
	}

	function rows(entity) {
		if (!tables.has(entity)) tables.set(entity, []);
		return tables.get(entity);
	}

	function primaryKeysFor(entity) {
		switch (entity) {
			case 'deviceOsCompatibility': return ['device_model_id', 'os_version_id'];
			case 'browserPlatformSupport': return ['browser_id', 'platform'];
			default: return ['id'];
		}
	}

	function upsert(entity, row) {
		const keys = primaryKeysFor(entity);
		const existing = rows(entity).find((candidate) => keys.every((key) => candidate[key] === row[key]));
		if (existing) Object.assign(existing, row);
		else rows(entity).push({ ...row });
	}

	return {
		async seed() {
			loadFromDisk();
			const seedData = buildCatalogSeed();
			const order = ['deviceCategories', 'hardware', 'osFamilies', 'osVersions', 'deviceModels', 'deviceGenerations', 'browsers', 'browserVersions', 'deviceOsCompatibility', 'browserPlatformSupport'];
			for (const entity of order) {
				for (const row of seedData[entity]) upsert(entity, row);
			}
			persistNow();
			return { inserted: order.reduce((sum, entity) => sum + rows(entity).length, 0) };
		},
		async list(entity, filters = {}) {
			loadFromDisk();
			const all = rows(entity);
			const entries = Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== '');
			return all
				.filter((row) => entries.every(([key, value]) => row[key] === value))
				.sort((left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0) || String(left.id ?? '').localeCompare(String(right.id ?? '')));
		},
		async create(entity, row) {
			loadFromDisk();
			let record = { ...row };
			if (entity === 'browserVersions' && !record.id) {
				record.id = `${record.browser_id}:${record.version}`;
			}
			if (entity === 'osVersions' && !record.id) {
				record.id = osVersionId(record.os_family_id, record.version);
			}
			upsert(entity, record);
			persistNow();
			const keys = primaryKeysFor(entity);
			return rows(entity).find((candidate) => keys.every((key) => candidate[key] === record[key])) ?? null;
		},
		async isCombinationSupported({ deviceSlug, platform, osVersion, browserCode, browserVersion }) {
			loadFromDisk();
			const device = rows('deviceModels').find((candidate) => candidate.slug === deviceSlug || candidate.id === deviceSlug);
			const category = device ? rows('deviceCategories').find((candidate) => candidate.id === device.category_id) : null;
			if (!device || !category) {
				return { ok: false, reason: `Unknown device "${deviceSlug}"` };
			}
			const effectivePlatform = platform ?? category.platform;
			// Windows accepts 'Windows 11' / 'Win 11' spellings — normalize the
			// trailing version number before the compatibility lookup.
			const normalizedOsVersion = effectivePlatform === 'windows'
				? (String(osVersion).match(/(\d+(?:\.\d+)*)\s*$/)?.[1] ?? osVersion)
				: osVersion;

			const supported = rows('deviceOsCompatibility').some(
				(row) => row.device_model_id === (device.id ?? deviceSlug) && row.os_version_id === osVersionId(effectivePlatform, normalizedOsVersion)
			);
			if (!supported) {
				return { ok: false, reason: `${device.display_name} does not support ${effectivePlatform} ${normalizedOsVersion}` };
			}

			const browserSupport = rows('browserPlatformSupport').find(
				(row) => row.browser_id === browserCode && row.platform === effectivePlatform
			);
			if (!browserSupport || !browserSupport.supported) {
				return { ok: false, reason: `Browser "${browserCode}" is not available on ${effectivePlatform}` };
			}

			if (browserVersion !== undefined && browserVersion !== null) {
				const browserRow = rows('browsers').find((candidate) => candidate.id === browserCode);
				if (browserRow?.independently_versioned) {
					const known = rows('browserVersions').some(
						(row) => row.browser_id === browserCode && row.version === String(browserVersion)
					);
					if (!known) {
						return { ok: false, reason: `Browser "${browserCode}" version ${browserVersion} is not in the catalog` };
					}
				}
			}

			return { ok: true };
		}
	};
}
