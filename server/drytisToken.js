import { createPublicKey, verify as verifySignature } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALGORITHMS = Object.freeze({ RS256: 'RSA-SHA256', EdDSA: null });
const ROLES = new Set(['owner', 'admin', 'developer', 'viewer']);

export class DrytisTokenError extends Error {
	constructor(message, code = 'QASE_DRYTIS_TOKEN_INVALID') {
		super(message);
		this.name = 'DrytisTokenError';
		this.code = code;
	}
}

function requiredString(value, label, maximum = 256) {
	if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
		throw new DrytisTokenError(`${label} is missing or invalid.`);
	}
	return value.trim();
}

function segmentJson(segment, label) {
	try {
		return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
	} catch {
		throw new DrytisTokenError(`Drytis token ${label} is not valid JSON.`);
	}
}

function audienceMatches(value, expected) {
	return typeof value === 'string' ? value === expected : Array.isArray(value) && value.includes(expected);
}

function numericDate(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new DrytisTokenError(`Drytis token ${label} must be a NumericDate.`);
	}
	return value;
}

function uuid(value, label) {
	const result = requiredString(value, label, 36).toLowerCase();
	if (!UUID_PATTERN.test(result)) throw new DrytisTokenError(`${label} must be a canonical UUID.`);
	return result;
}

function slug(value, label) {
	const result = requiredString(value, label, 63);
	if (!SLUG_PATTERN.test(result)) throw new DrytisTokenError(`${label} must be a DNS-safe slug.`);
	return result;
}

function displayName(value, label) {
	const result = requiredString(value, label, 120);
	if (/[\u0000-\u001f\u007f]/.test(result)) throw new DrytisTokenError(`${label} contains control characters.`);
	return result;
}

function identityClaims(payload) {
	const email = requiredString(payload.email, 'email', 254).toLowerCase();
	if (!EMAIL_PATTERN.test(email)) throw new DrytisTokenError('email is invalid.');
	const role = requiredString(payload.role, 'role', 32);
	if (!ROLES.has(role)) throw new DrytisTokenError('role is not supported.');
	const organization = payload.organization;
	const project = payload.project;
	if (!organization || typeof organization !== 'object' || !project || typeof project !== 'object') {
		throw new DrytisTokenError('organization and project claims are required.');
	}
	return Object.freeze({
		subject: requiredString(payload.sub, 'sub', 255),
		jti: requiredString(payload.jti, 'jti', 255),
		actorUserId: uuid(payload.user_id, 'user_id'),
		email,
		displayName: displayName(payload.name ?? email, 'name'),
		role,
		organizationId: uuid(organization.id, 'organization.id'),
		organizationSlug: slug(organization.slug, 'organization.slug'),
		organizationName: displayName(organization.name, 'organization.name'),
		projectId: uuid(project.id, 'project.id'),
		projectSlug: slug(project.slug, 'project.slug'),
		projectName: displayName(project.name, 'project.name')
	});
}

/** Verifies short-lived Drytis launch JWTs and refreshes JWKS on key rotation. */
export function createDrytisTokenVerifier(options = {}) {
	const issuer = requiredString(options.issuer, 'issuer', 2048);
	const audience = requiredString(options.audience, 'audience', 512);
	const jwksUrl = new URL(requiredString(options.jwksUrl, 'jwksUrl', 2048));
	if (jwksUrl.protocol !== 'https:' && !options.allowInsecureJwks) {
		throw new TypeError('Drytis JWKS URL must use HTTPS.');
	}
	const fetchImpl = options.fetch ?? globalThis.fetch;
	if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
	const now = options.now ?? (() => Date.now());
	const clockToleranceSeconds = Number(options.clockToleranceSeconds ?? 30);
	const maxTokenLifetimeSeconds = Number(options.maxTokenLifetimeSeconds ?? 300);
	const cacheMs = Number(options.cacheMs ?? 5 * 60 * 1000);
	let cachedKeys = new Map();
	let cacheExpiresAt = 0;
	let lastRefreshAt = 0;
	let refreshPromise;

	async function refresh() {
		if (refreshPromise) return refreshPromise;
		refreshPromise = (async () => {
			const response = await fetchImpl(jwksUrl, { headers: { Accept: 'application/json' }, redirect: 'error' });
			if (!response.ok) throw new DrytisTokenError('Drytis signing keys are unavailable.', 'QASE_DRYTIS_JWKS_UNAVAILABLE');
			const declaredLength = Number(response.headers?.get?.('content-length'));
			if (Number.isFinite(declaredLength) && declaredLength > 1_048_576) {
				throw new DrytisTokenError('Drytis JWKS response is too large.', 'QASE_DRYTIS_JWKS_UNAVAILABLE');
			}
			const text = await response.text();
			if (Buffer.byteLength(text, 'utf8') > 1_048_576) {
				throw new DrytisTokenError('Drytis JWKS response is too large.', 'QASE_DRYTIS_JWKS_UNAVAILABLE');
			}
			let body;
			try { body = JSON.parse(text); } catch {
				throw new DrytisTokenError('Drytis JWKS response is invalid.', 'QASE_DRYTIS_JWKS_UNAVAILABLE');
			}
			if (!Array.isArray(body?.keys) || body.keys.length === 0 || body.keys.length > 100) {
				throw new DrytisTokenError('Drytis JWKS response is invalid.', 'QASE_DRYTIS_JWKS_UNAVAILABLE');
			}
			const next = new Map();
			for (const jwk of body.keys) {
				if (!jwk || typeof jwk !== 'object' || typeof jwk.kid !== 'string' || !Object.hasOwn(ALGORITHMS, jwk.alg)) continue;
				if (jwk.use && jwk.use !== 'sig') continue;
				try { next.set(`${jwk.alg}:${jwk.kid}`, createPublicKey({ key: jwk, format: 'jwk' })); } catch { /* ignore malformed keys */ }
			}
			if (next.size === 0) throw new DrytisTokenError('Drytis JWKS has no supported signing keys.', 'QASE_DRYTIS_JWKS_UNAVAILABLE');
			cachedKeys = next;
			lastRefreshAt = now();
			cacheExpiresAt = lastRefreshAt + cacheMs;
		})().finally(() => { refreshPromise = undefined; });
		return refreshPromise;
	}

	async function keyFor(header, force = false) {
		const kid = requiredString(header.kid, 'kid', 255);
		const algorithm = requiredString(header.alg, 'alg', 16);
		if (!Object.hasOwn(ALGORITHMS, algorithm) || (header.typ !== undefined && header.typ !== 'JWT')) {
			throw new DrytisTokenError('Drytis token algorithm or type is not allowed.');
		}
		const current = now();
		const needsRefresh = force || cacheExpiresAt <= current || !cachedKeys.has(`${algorithm}:${kid}`);
		if (needsRefresh && (cachedKeys.size === 0 || current - lastRefreshAt >= 10_000)) await refresh();
		return { key: cachedKeys.get(`${algorithm}:${kid}`), kid, algorithm };
	}

	return Object.freeze({
		async verify(token) {
			const compact = requiredString(token, 'launch token', 16_384);
			const segments = compact.split('.');
			if (segments.length !== 3 || segments.some(segment => segment === '')) throw new DrytisTokenError('Drytis token is malformed.');
			const header = segmentJson(segments[0], 'header');
			const payload = segmentJson(segments[1], 'payload');
			let selected = await keyFor(header);
			let valid = selected.key && verifySignature(
				ALGORITHMS[selected.algorithm], Buffer.from(`${segments[0]}.${segments[1]}`), selected.key,
				Buffer.from(segments[2], 'base64url')
			);
			if (!valid) {
				selected = await keyFor(header, true);
				valid = selected.key && verifySignature(
					ALGORITHMS[selected.algorithm], Buffer.from(`${segments[0]}.${segments[1]}`), selected.key,
					Buffer.from(segments[2], 'base64url')
				);
			}
			if (!valid) throw new DrytisTokenError('Drytis token signature is invalid.');
			const current = Math.floor(now() / 1000);
			const exp = numericDate(payload.exp, 'exp');
			const iat = numericDate(payload.iat, 'iat');
			if (payload.iss !== issuer || !audienceMatches(payload.aud, audience)) throw new DrytisTokenError('Drytis token issuer or audience is invalid.');
			if (exp <= current - clockToleranceSeconds || iat > current + clockToleranceSeconds) throw new DrytisTokenError('Drytis token is expired or not active.');
			if (payload.nbf !== undefined && numericDate(payload.nbf, 'nbf') > current + clockToleranceSeconds) throw new DrytisTokenError('Drytis token is not active yet.');
			if (exp - iat > maxTokenLifetimeSeconds) throw new DrytisTokenError('Drytis token lifetime is too long.');
			return Object.freeze({ ...identityClaims(payload), issuer, issuedAt: iat, expiresAt: exp });
		}
	});
}
