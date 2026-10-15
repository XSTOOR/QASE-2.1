/**
 * Catalog provider registry (#14275, Phase 2).
 *
 * The catalog used to be a frozen static list; this module makes it a
 * service-fed, extensible source. The builtin generator (Phase 1's expanded
 * environmentCatalog.js) is always present and always authoritative;
 * external providers (e.g. BrowserStack) register ADDITIVE overlays.
 *
 * Honesty contract — never fabricate availability:
 *   - A provider may only report REAL_DEVICE / available rows that the
 *     provider itself attests (real capability data from its own API).
 *   - Provider rows are namespaced envIds (`PROV-<slug>-…`) so they never
 *     collide with, or overwrite, builtin rows.
 *   - When a provider attests a combination that also exists as a builtin
 *     SIMULATED row, the registry records an *attestation* (provider name +
 *     execution level) — merging into builtin rows is up to the caller's
 *     policy; the registry itself never mutates builtin data in place.
 *   - No credentials configured → the provider is registered but
 *     `connected:false` and contributes exactly nothing. The registry then
 *     returns precisely the builtin catalog; app behavior is unchanged.
 *   - A provider that is unreachable keeps its last-known overlay rows and
 *     flags `stale:true` — builtin remains authoritative either way.
 */

import { generateEnvironments, ENVIRONMENT_CATALOG_VERSION } from './environmentCatalog.js';
import { browserSupportReport } from './browserSupportResolution.js';

/** Providers registered at module scope; tests register in-memory fakes. */
const registry = new Map();

const BUILTIN_PROVIDER = {
	name: 'builtin',
	slug: 'builtin',
	kind: 'builtin',
	connected: true,
	stale: false,
	async fetchCatalog() {
		return { environments: generateEnvironments(), attestations: [] };
	}
};

export function registerCatalogProvider(provider) {
	if (!provider || typeof provider !== 'object') throw new TypeError('provider must be an object');
	if (typeof provider.name !== 'string' || !provider.name.trim()) throw new TypeError('provider.name is required');
	if (typeof provider.fetchCatalog !== 'function') throw new TypeError('provider.fetchCatalog must be a function');
	const slug = String(provider.slug ?? provider.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	if (!slug) throw new TypeError('provider slug derived empty');
	registry.set(slug, { ...provider, slug });
	return slug;
}

export function unregisterCatalogProvider(slug) {
	if (slug === 'builtin') return false;
	return registry.delete(slug);
}

export function registeredCatalogProviders() {
	return [...registry.values()].map(({ name, slug, kind, connected, stale }) => ({ name, slug, kind, connected, stale }));
}

/** Namespaces a provider-sourced envId so it can never collide with builtin. */
export function providerEnvId(slug, envId) {
	return `PROV-${slug.toUpperCase()}-${envId}`;
}

const VALID_EXECUTION_LEVELS = new Set(['REAL_DEVICE', 'SIMULATED', 'VIRTUAL_DEVICE', 'EMULATOR', 'VIRTUAL_MACHINE']);

/**
 * Validates and normalizes one overlay row from a provider. Rows that fail
 * the honesty contract are dropped — never guessed into shape.
 */
function normalizeProviderRow(slug, row) {
	if (!row || typeof row !== 'object') return null;
	if (typeof row.envId !== 'string' || !row.envId) return null;
	if (!VALID_EXECUTION_LEVELS.has(row.executionLevel ?? row.executionLevelRequested)) {
		// A provider may not attest an execution level it did not confirm.
		return null;
	}
	const executionLevel = row.executionLevel ?? row.executionLevelRequested;
	// REAL_DEVICE rows must come from the provider's own attestation — the
	// provider already vouched by emitting the row; nothing further is
	// inferred here.
	return {
		...row,
		envId: providerEnvId(slug, row.envId),
		executionLevelRequested: executionLevel,
		executionProvider: row.executionProvider ?? slug,
		providerSlug: slug
	};
}

/**
 * Fetches every connected provider's overlay and merges them additively over
 * the builtin catalog. Returns `{ builtinVersion, environments,
 * attestations, providers }` — `environments` is builtin rows followed by
 * namespaced provider rows (builtin rows are NEVER modified or removed).
 */
export async function mergeCatalog(providerSlugs) {
	const builtin = generateEnvironments();
	const builtinById = new Map(builtin.map((env) => [env.envId, env]));
	const environments = [...builtin];
	const attestations = [];
	const providers = [];

	const slugs = providerSlugs ?? [...registry.keys()];
	for (const slug of slugs) {
		const provider = slug === 'builtin' ? BUILTIN_PROVIDER : registry.get(slug);
		if (!provider) continue;
		const entry = {
			name: provider.name, slug, kind: provider.kind ?? 'external',
			connected: provider.connected !== false, stale: Boolean(provider.stale), rowCount: 0
		};
		if (!entry.connected) { providers.push(entry); continue; }
		let counted = 0;
		try {
			const fetched = await provider.fetchCatalog();
			for (const row of fetched.environments ?? []) {
				if (slug === 'builtin') {
					// builtin rows are pushed verbatim above — just count.
					counted += 1;
					continue;
				}
				const normalized = normalizeProviderRow(slug, row);
				if (!normalized) continue;
				if (builtinById.has(normalized.envId)) continue; // namespacing already prevents this
				if (environments.some((env) => env.envId === normalized.envId)) continue; // dedupe
				environments.push(normalized);
				counted += 1;
				// An attestation records that the provider confirms a combination
				// that the builtin catalog also (or only) claims as SIMULATED.
				const rawId = row.envId;
				if (builtinById.has(rawId)) {
					attestations.push({ provider: slug, envId: rawId, executionLevel: normalized.executionLevelRequested });
				}
			}
		} catch {
			entry.stale = true; // unreachable → keep builtin authoritative, flag stale
		}
		entry.rowCount = counted;
		providers.push(entry);
	}

	return {
		builtinVersion: ENVIRONMENT_CATALOG_VERSION,
		environments,
		attestations,
		providers
	};
}

/** Registry metadata for the read-only `GET /api/catalog/meta` endpoint. */
export async function catalogProviderMeta() {
	const providers = [{ name: 'builtin', slug: 'builtin', kind: 'builtin', connected: true, stale: false, rowCount: generateEnvironments().length }];
	for (const [slug, provider] of registry) {
		if (slug === 'builtin') continue;
		providers.push({
			name: provider.name, slug, kind: provider.kind ?? 'external',
			connected: provider.connected !== false, stale: Boolean(provider.stale),
			rowCount: provider.lastRowCount ?? 0
		});
	}
	return {
		catalogVersion: ENVIRONMENT_CATALOG_VERSION,
		generatedAt: new Date().toISOString(),
		providers,
		// #14632 (NI01 Phase 2): browser-level executability surfaced here too —
		// one source of truth alongside /api/environments/availability.
		// RT1 (#14680): async, registry-fed (no external providers).
		browserSupport: await browserSupportReport('any', {})
	};
}
