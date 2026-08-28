import { createSecretKey } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 10_000;
// The deterministic white-box snapshot accepts up to 12 MiB of source text;
// leave bounded JSON overhead without allowing arbitrary unbounded uploads.
const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_CLOCK_SKEW_SECONDS = 300;

function required(environment, name) {
	const value = environment[name];
	if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
		throw new TypeError(`${name} is required and must not have surrounding whitespace.`);
	}
	if (/\p{Cc}/u.test(value)) throw new TypeError(`${name} contains invalid control characters.`);
	return value;
}

function boundedInteger(environment, name, fallback, minimum, maximum) {
	const raw = environment[name];
	if (raw === undefined || raw === '') return fallback;
	if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
		throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
	}
	return value;
}

function exactHttpsOrigin(value, name) {
	let url;
	try { url = new URL(value); } catch { throw new TypeError(`${name} must be a valid HTTPS origin.`); }
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
		|| url.hostname.includes('*')
		|| url.pathname !== '/' || url.origin === 'null') {
		throw new TypeError(`${name} must be an exact HTTPS origin without credentials, path, query, or fragment.`);
	}
	return url.origin;
}

function signingKey(environment) {
	const encoded = required(environment, 'QASE_DRYTIS_HMAC_KEY');
	if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
		throw new TypeError('QASE_DRYTIS_HMAC_KEY must be an unpadded base64url-encoded 32-byte key.');
	}
	const material = Buffer.from(encoded, 'base64url');
	if (material.length !== 32 || material.toString('base64url') !== encoded) {
		material.fill(0);
		throw new TypeError('QASE_DRYTIS_HMAC_KEY must be an unpadded base64url-encoded 32-byte key.');
	}
	try {
		// KeyObject does not serialize its secret material if the config is logged or
		// accidentally included in a diagnostic payload.
		return createSecretKey(material);
	} finally {
		material.fill(0);
	}
}

function allowedOrigins(environment, apiOrigin) {
	const raw = required(environment, 'QASE_DRYTIS_ALLOWED_ORIGINS');
	const candidates = raw.split(',');
	if (candidates.length > 20 || candidates.some(candidate => !candidate || candidate !== candidate.trim())) {
		throw new TypeError('QASE_DRYTIS_ALLOWED_ORIGINS must contain 1 to 20 comma-separated exact HTTPS origins.');
	}
	const origins = [...new Set(candidates.map((candidate, index) =>
		exactHttpsOrigin(candidate, `QASE_DRYTIS_ALLOWED_ORIGINS[${index}]`)))];
	if (!origins.includes(apiOrigin)) {
		throw new TypeError('QASE_DRYTIS_API_ORIGIN must be present in QASE_DRYTIS_ALLOWED_ORIGINS.');
	}
	return Object.freeze(origins);
}

/**
 * Parse the fail-closed server-to-server Drytis transport configuration.
 *
 * Required environment variables:
 * - QASE_DRYTIS_API_ORIGIN: the primary exact HTTPS origin
 * - QASE_DRYTIS_ALLOWED_ORIGINS: comma-separated exact HTTPS origins
 * - QASE_DRYTIS_HMAC_KEY: unpadded base64url encoding of exactly 32 random bytes
 */
export function createDrytisIntegrationConfig(environment = process.env) {
	const apiOrigin = exactHttpsOrigin(required(environment, 'QASE_DRYTIS_API_ORIGIN'), 'QASE_DRYTIS_API_ORIGIN');
	const maxClockSkewSeconds = boundedInteger(environment,
		'QASE_DRYTIS_MAX_CLOCK_SKEW_SECONDS', DEFAULT_CLOCK_SKEW_SECONDS, 30, 900);
	return Object.freeze({
		apiOrigin,
		allowedOrigins: allowedOrigins(environment, apiOrigin),
		signingKey: signingKey(environment),
		timeoutMs: boundedInteger(environment, 'QASE_DRYTIS_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 250, 30_000),
		maxRequestBytes: boundedInteger(environment, 'QASE_DRYTIS_MAX_REQUEST_BYTES',
			DEFAULT_MAX_REQUEST_BYTES, 1024, 16 * 1024 * 1024),
		maxResponseBytes: boundedInteger(environment, 'QASE_DRYTIS_MAX_RESPONSE_BYTES',
			DEFAULT_MAX_RESPONSE_BYTES, 1024, 5 * 1024 * 1024),
		maxClockSkewMs: maxClockSkewSeconds * 1000
	});
}
