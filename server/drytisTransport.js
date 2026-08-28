import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sanitizeErrorDetail } from './errorSanitizer.js';

export const DRYTIS_SIGNATURE_VERSION = 'qase-drytis-hmac-v1';
export const DRYTIS_INBOUND_HEADERS = Object.freeze({
	signature: 'x-drytis-signature',
	timestamp: 'x-drytis-timestamp',
	nonce: 'x-drytis-nonce',
	idempotencyKey: 'idempotency-key',
	correlationId: 'x-correlation-id'
});
export const DRYTIS_OUTBOUND_HEADERS = Object.freeze({
	signature: 'x-qase-signature',
	timestamp: 'x-qase-timestamp',
	nonce: 'x-qase-nonce',
	idempotencyKey: 'idempotency-key',
	correlationId: 'x-correlation-id'
});

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._~:/-]*$/;
const METHODS = /^(?:DELETE|GET|PATCH|POST|PUT)$/;
const SIGNATURE = /^v1=([0-9a-f]{64})$/;

export class DrytisTransportError extends Error {
	constructor(message, { code = 'drytis_transport_error', status = 502, retryable = false, upstreamStatus } = {}) {
		super(message);
		this.name = 'DrytisTransportError';
		this.code = code;
		this.status = status;
		this.retryable = retryable;
		if (Number.isInteger(upstreamStatus)) this.upstreamStatus = upstreamStatus;
	}
}

function boundedToken(value, name, minimum, maximum) {
	if (typeof value !== 'string' || value.length < minimum || value.length > maximum || !TOKEN.test(value)) {
		throw new DrytisTransportError(`The signed Drytis request has an invalid ${name}.`, {
			code: 'invalid_signed_request', status: 400
		});
	}
	return value;
}

function normalizeMethod(method) {
	const result = String(method ?? '').toUpperCase();
	if (!METHODS.test(result)) {
		throw new DrytisTransportError('The signed Drytis request has an invalid method.', {
			code: 'invalid_signed_request', status: 400
		});
	}
	return result;
}

function normalizeTarget(target) {
	if (typeof target !== 'string' || !target.startsWith('/') || target.length > 8192
		|| target.includes('#') || /[\u0000-\u001f\u007f]/.test(target)) {
		throw new DrytisTransportError('The signed Drytis request has an invalid request target.', {
			code: 'invalid_signed_request', status: 400
		});
	}
	return target;
}

function bodyBytes(value, maximum) {
	if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) {
		throw new DrytisTransportError('The signed Drytis request body must be supplied as raw bytes.', {
			code: 'invalid_signed_request', status: 400
		});
	}
	const bytes = Buffer.from(value);
	if (bytes.length > maximum) {
		throw new DrytisTransportError('The signed Drytis request is too large.', {
			code: 'request_too_large', status: 413
		});
	}
	return bytes;
}

function headerValue(headers, name) {
	let value;
	if (headers && typeof headers.get === 'function') value = headers.get(name);
	else if (headers && typeof headers === 'object') {
		value = headers[name] ?? headers[name.toLowerCase()];
		if (value === undefined) {
			const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name);
			value = key === undefined ? undefined : headers[key];
		}
	}
	if (Array.isArray(value)) return value.length === 1 ? String(value[0]) : undefined;
	return value === undefined || value === null ? undefined : String(value);
}

function requestHeaders(headers, names) {
	return {
		signature: headerValue(headers, names.signature),
		timestamp: headerValue(headers, names.timestamp),
		nonce: headerValue(headers, names.nonce),
		idempotencyKey: headerValue(headers, names.idempotencyKey),
		correlationId: headerValue(headers, names.correlationId)
	};
}

function bodyDigest(body) {
	return createHash('sha256').update(body).digest('hex');
}

/** Domain-separated canonical form shared with Drytis. It signs the exact raw request target and bytes. */
export function canonicalDrytisRequest({ signer, timestamp, nonce, idempotencyKey, correlationId, method, requestTarget, body }) {
	if (!['drytis', 'qase'].includes(signer)) throw new TypeError('signer must be drytis or qase.');
	const safeTimestamp = String(timestamp);
	timestampSeconds(safeTimestamp);
	const safeNonce = boundedToken(nonce, 'nonce', 16, 128);
	const safeIdempotencyKey = boundedToken(idempotencyKey, 'idempotency key', 8, 200);
	const safeCorrelationId = boundedToken(correlationId, 'correlation ID', 8, 128);
	const bytes = Buffer.isBuffer(body) || body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(String(body ?? ''), 'utf8');
	return [
		DRYTIS_SIGNATURE_VERSION,
		signer,
		safeTimestamp,
		safeNonce,
		safeIdempotencyKey,
		safeCorrelationId,
		normalizeMethod(method),
		normalizeTarget(requestTarget),
		bodyDigest(bytes)
	].join('\n');
}

export function signDrytisRequest({ signingKey, ...request }) {
	if (!signingKey) throw new TypeError('A signing key is required.');
	const canonical = canonicalDrytisRequest(request);
	return `v1=${createHmac('sha256', signingKey).update(canonical, 'utf8').digest('hex')}`;
}

function compareSignature(expected, supplied) {
	const match = SIGNATURE.exec(String(supplied ?? ''));
	const actual = match ? Buffer.from(match[1], 'hex') : Buffer.alloc(32);
	const expectedBytes = Buffer.from(expected.slice(3), 'hex');
	const equal = timingSafeEqual(expectedBytes, actual);
	actual.fill(0);
	expectedBytes.fill(0);
	return Boolean(match) && equal;
}

function timestampSeconds(value) {
	if (typeof value !== 'string' || !/^\d{10,11}$/.test(value)) {
		throw new DrytisTransportError('The signed Drytis request has an invalid timestamp.', {
			code: 'invalid_signed_request', status: 400
		});
	}
	const result = Number(value);
	if (!Number.isSafeInteger(result)) {
		throw new DrytisTransportError('The signed Drytis request has an invalid timestamp.', {
			code: 'invalid_signed_request', status: 400
		});
	}
	return result;
}

/**
 * Build an inbound verifier. `nonceStore.consume(key, expiresAtMs)` must be an
 * atomic set-if-absent operation and return true only for the first consumer.
 */
export function createDrytisRequestVerifier({ config, nonceStore, now = Date.now } = {}) {
	if (!config?.signingKey || !Number.isSafeInteger(config.maxRequestBytes)
		|| !Number.isSafeInteger(config.maxClockSkewMs)) {
		throw new TypeError('A valid Drytis integration config is required.');
	}
	if (!nonceStore || typeof nonceStore.consume !== 'function') {
		throw new TypeError('An atomic Drytis nonce store is required.');
	}

	return Object.freeze({
		async verify({ method, requestTarget, headers, rawBody }) {
			const normalizedMethod = normalizeMethod(method);
			const normalizedTarget = normalizeTarget(requestTarget);
			const body = bodyBytes(rawBody, config.maxRequestBytes);
			const supplied = requestHeaders(headers, DRYTIS_INBOUND_HEADERS);
			const timestamp = timestampSeconds(supplied.timestamp);
			const nonce = boundedToken(supplied.nonce, 'nonce', 16, 128);
			const idempotencyKey = boundedToken(supplied.idempotencyKey, 'idempotency key', 8, 200);
			const correlationId = boundedToken(supplied.correlationId, 'correlation ID', 8, 128);
			const nowMs = Number(now());
			if (!Number.isFinite(nowMs) || Math.abs(nowMs - timestamp * 1000) > config.maxClockSkewMs) {
				throw new DrytisTransportError('The signed Drytis request timestamp is outside the accepted window.', {
					code: 'stale_signed_request', status: 401
				});
			}
			const expected = signDrytisRequest({
				signingKey: config.signingKey, signer: 'drytis', timestamp: supplied.timestamp,
				nonce, idempotencyKey, correlationId, method: normalizedMethod,
				requestTarget: normalizedTarget, body
			});
			if (!compareSignature(expected, supplied.signature)) {
				throw new DrytisTransportError('The signed Drytis request could not be authenticated.', {
					code: 'invalid_signature', status: 401
				});
			}
			const replayKey = createHash('sha256').update(`drytis\0${nonce}`, 'utf8').digest('hex');
			let firstUse;
			try {
				firstUse = await nonceStore.consume(replayKey, timestamp * 1000 + config.maxClockSkewMs + 1000);
			} catch {
				throw new DrytisTransportError('Drytis request authentication is temporarily unavailable.', {
					code: 'nonce_store_unavailable', status: 503, retryable: true
				});
			}
			if (firstUse !== true) {
				throw new DrytisTransportError('The signed Drytis request was already received.', {
					code: 'replayed_signed_request', status: 409
				});
			}
			return Object.freeze({
				idempotencyKey, correlationId, timestamp: new Date(timestamp * 1000).toISOString(),
				bodyDigest: bodyDigest(body)
			});
		}
	});
}

/** A bounded process-local nonce store for development and single-node tests. */
export function createMemoryDrytisNonceStore({ now = Date.now, maxEntries = 10_000 } = {}) {
	if (!Number.isSafeInteger(maxEntries) || maxEntries < 100 || maxEntries > 1_000_000) {
		throw new TypeError('maxEntries must be an integer from 100 to 1000000.');
	}
	const nonces = new Map();
	function prune(time) {
		for (const [key, expiresAt] of nonces) if (expiresAt <= time) nonces.delete(key);
	}
	return Object.freeze({
		async consume(key, expiresAtMs) {
			const time = Number(now());
			if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)
				|| !Number.isFinite(expiresAtMs) || expiresAtMs <= time) {
				throw new TypeError('The nonce reservation is invalid.');
			}
			prune(time);
			if (nonces.has(key)) return false;
			if (nonces.size >= maxEntries) throw new Error('The nonce store is at capacity.');
			nonces.set(key, expiresAtMs);
			return true;
		},
		size() { prune(Number(now())); return nonces.size; }
	});
}

function outboundTarget(config, value) {
	if (typeof value !== 'string' || value.length === 0 || value.length > 8192) {
		throw new DrytisTransportError('The Drytis delivery target is invalid.', { code: 'invalid_delivery', status: 400 });
	}
	let url;
	try { url = new URL(value, `${config.apiOrigin}/`); }
	catch { throw new DrytisTransportError('The Drytis delivery target is invalid.', { code: 'invalid_delivery', status: 400 }); }
	if (url.protocol !== 'https:' || url.username || url.password || url.hash
		|| !config.allowedOrigins.includes(url.origin)) {
		throw new DrytisTransportError('The Drytis delivery target is not allowlisted.', {
			code: 'destination_not_allowed', status: 400
		});
	}
	return url;
}

async function readBoundedJson(response, maximum) {
	const declared = response.headers.get('content-length');
	if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
		throw new DrytisTransportError('Drytis returned an invalid or oversized response.', {
			code: 'invalid_upstream_response', status: 502
		});
	}
	const contentType = String(response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
	if (!(contentType === 'application/json' || contentType.endsWith('+json')) || !response.body?.getReader) {
		throw new DrytisTransportError('Drytis returned an invalid response.', {
			code: 'invalid_upstream_response', status: 502
		});
	}
	const reader = response.body.getReader();
	const chunks = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > maximum) {
				await reader.cancel();
				throw new DrytisTransportError('Drytis returned an oversized response.', {
					code: 'upstream_response_too_large', status: 502
				});
			}
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), length);
	try { return JSON.parse(bytes.toString('utf8')); }
	catch {
		throw new DrytisTransportError('Drytis returned invalid JSON.', {
			code: 'invalid_upstream_response', status: 502
		});
	}
}

function jsonBytes(payload, maximum) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new DrytisTransportError('Drytis delivery payloads must be JSON objects.', {
			code: 'invalid_delivery', status: 400
		});
	}
	let serialized;
	try { serialized = JSON.stringify(payload); }
	catch { throw new DrytisTransportError('The Drytis delivery payload is not valid JSON.', { code: 'invalid_delivery', status: 400 }); }
	if (serialized === undefined) {
		throw new DrytisTransportError('The Drytis delivery payload is not valid JSON.', {
			code: 'invalid_delivery', status: 400
		});
	}
	const bytes = Buffer.from(serialized, 'utf8');
	if (bytes.length > maximum) {
		throw new DrytisTransportError('The Drytis delivery payload is too large.', {
			code: 'request_too_large', status: 413
		});
	}
	return bytes;
}

/** Create a fail-closed, signed JSON delivery client for Qase -> Drytis events/results. */
export function createDrytisDeliveryClient({
	config, fetchImpl = fetch, now = Date.now,
	createNonce = () => randomBytes(24).toString('base64url'),
	createTimeoutSignal = timeoutMs => AbortSignal.timeout(timeoutMs)
} = {}) {
	if (!config?.signingKey || !Array.isArray(config.allowedOrigins)
		|| !Number.isSafeInteger(config.timeoutMs) || !Number.isSafeInteger(config.maxRequestBytes)
		|| !Number.isSafeInteger(config.maxResponseBytes)) {
		throw new TypeError('A valid Drytis integration config is required.');
	}
	if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');

	return Object.freeze({
		async deliver(target, payload, { idempotencyKey, correlationId } = {}) {
			const url = outboundTarget(config, target);
			const requestTarget = `${url.pathname}${url.search}`;
			const body = jsonBytes(payload, config.maxRequestBytes);
			const timestamp = String(Math.floor(Number(now()) / 1000));
			if (!/^\d{10,11}$/.test(timestamp)) {
				throw new DrytisTransportError('The Drytis delivery timestamp is unavailable.', {
					code: 'invalid_delivery', status: 500
				});
			}
			const nonce = boundedToken(createNonce(), 'nonce', 16, 128);
			const safeIdempotencyKey = boundedToken(idempotencyKey, 'idempotency key', 8, 200);
			const safeCorrelationId = boundedToken(correlationId, 'correlation ID', 8, 128);
			const signature = signDrytisRequest({
				signingKey: config.signingKey, signer: 'qase', timestamp, nonce,
				idempotencyKey: safeIdempotencyKey, correlationId: safeCorrelationId,
				method: 'POST', requestTarget, body
			});
			let response;
			try {
				response = await fetchImpl(url.href, {
					method: 'POST', body, redirect: 'error', signal: createTimeoutSignal(config.timeoutMs),
					headers: {
						Accept: 'application/json', 'Content-Type': 'application/json',
						[DRYTIS_OUTBOUND_HEADERS.timestamp]: timestamp,
						[DRYTIS_OUTBOUND_HEADERS.nonce]: nonce,
						[DRYTIS_OUTBOUND_HEADERS.idempotencyKey]: safeIdempotencyKey,
						[DRYTIS_OUTBOUND_HEADERS.correlationId]: safeCorrelationId,
						[DRYTIS_OUTBOUND_HEADERS.signature]: signature
					}
				});
			} catch (error) {
				throw new DrytisTransportError(`Drytis delivery failed: ${sanitizeErrorDetail(error, 300)}`, {
					code: 'delivery_failed', status: 502, retryable: true
				});
			}
			if (!response?.ok) {
				try { await response?.body?.cancel(); } catch { /* best-effort release */ }
				const upstreamStatus = Number.isInteger(response?.status) ? response.status : undefined;
				throw new DrytisTransportError(
					upstreamStatus ? `Drytis rejected the delivery with HTTP ${upstreamStatus}.` : 'Drytis rejected the delivery.',
					{ code: 'delivery_rejected', status: 502, retryable: upstreamStatus === 408 || upstreamStatus === 429
						|| (upstreamStatus >= 500 && upstreamStatus <= 599), upstreamStatus }
				);
			}
			const responseBody = response.status === 204 ? null : await readBoundedJson(response, config.maxResponseBytes);
			return Object.freeze({ status: response.status, body: responseBody, correlationId: safeCorrelationId });
		}
	});
}
