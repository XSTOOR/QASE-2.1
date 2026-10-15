/**
 * Phase R4 (#14493) · Runtime-sourced evidence bundles.
 *
 * Persists, per run, one `evidence-bundle` JSON artifact whose contents come
 * ONLY from the live runtime: the observed user agent / browser identity
 * (R2), the page's console entries and network requests captured by the
 * browser automation service, the final screenshot, and the honest execution
 * metadata. Nothing is fabricated: an entry that could not be observed is
 * recorded as absent (`null`), never invented. The bundle carries the report
 * runtimeIdentity so a PASS verdict can always be traced to the exact runtime
 * that executed it.
 */

import { verifyRuntimeIdentity } from './runtimeIdentity.js';

const MAX_CONSOLE_ENTRIES = 500;
const MAX_NETWORK_ENTRIES = 500;
const MAX_ENTRY_BYTES = 2000;

function boundedEntries(entries, limit = MAX_CONSOLE_ENTRIES) {
	if (!Array.isArray(entries)) return null;
	const clipped = entries.slice(0, limit).map((entry) => {
		if (typeof entry === 'string') return entry.slice(0, MAX_ENTRY_BYTES);
		if (entry && typeof entry === 'object') {
			return Object.fromEntries(Object.entries(entry).map(([key, value]) => [
				key,
				typeof value === 'string' ? value.slice(0, MAX_ENTRY_BYTES) : value
			]));
		}
		return entry;
	});
	return { count: entries.length, truncated: entries.length > clipped.length, entries: clipped };
}

/**
 * Collect one evidence bundle for a session.
 * @param {object} options
 * @param {object} options.session - the run (runtimeFacts, environmentSnapshot…)
 * @param {object} options.bridge - the browser bridge (getLastFrame, execution)
 * @param {object} [options.diagnostics] - console/network from the live service
 * @returns {{ bundle: object }} the bundle (no side effects; persisting is the store's job)
 */
export function collectEvidenceBundle({ session, bridge, diagnostics } = {}) {
	const environment = session?.environmentSnapshot ?? null;
	const runtimeFacts = session?.runtimeFacts ?? null;
	const identity = runtimeFacts || environment
		? verifyRuntimeIdentity({ runtimeFacts, environment })
		: null;
	const frame = bridge?.getLastFrame?.() ?? null;
	const level = runtimeFacts?.executionLevel ?? session?.executionLevel ?? bridge?.execution?.level ?? null;
	const consoleEntries = boundedEntries(diagnostics?.console);
	const networkEntries = boundedEntries(diagnostics?.network, MAX_NETWORK_ENTRIES);
	return {
		bundle: {
			type: 'evidence-bundle',
			capturedAt: new Date().toISOString(),
			sessionId: session?.id ?? null,
			execution: {
				level,
				levelHonest: level !== 'REAL_DEVICE' || Boolean(runtimeFacts?.attestation?.capabilities_verified),
				provider: runtimeFacts?.provider ?? session?.executionProviderActual ?? bridge?.execution?.provider ?? null,
				engine: bridge?.execution?.executionEngine ?? null
			},
			// Runtime-authoritative identity (R2) — what the runtime OBSERVED.
			identity: identity?.identity ?? null,
			identityVerified: identity ? identity.ok : null,
			identityMismatches: identity && !identity.ok ? identity.mismatches : [],
			// Runtime session the evidence belongs to.
			runtimeSessionId: session?.deviceSessionId ?? runtimeFacts?.runtimeSessionId ?? null,
			environment: environment ? {
				envId: environment.envId ?? null,
				device: environment.device ?? null,
				os: environment.os ?? null,
				osVersion: environment.osVersion ?? null,
				browser: environment.browser ?? null,
				browserVersion: environment.browserVersion ?? null,
				resolution: environment.resolution ?? null,
				orientation: environment.orientation ?? null
			} : null,
			screenshot: frame?.base64
				? { fileName: `final-frame-${(session?.id ?? 'run').slice(0, 8)}.jpg`, contentType: frame?.mimeType ?? 'image/jpeg' }
				: null,
			console: consoleEntries,
			network: networkEntries,
			securityBlocks: Array.isArray(bridge?.getSecurityBlocks?.()) ? bridge.getSecurityBlocks() : []
		}
	};
}
