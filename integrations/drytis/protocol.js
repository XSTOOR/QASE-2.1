import { createHash, createHmac } from 'node:crypto';

/**
 * Portable Drytis -> Qase wire contract.
 *
 * This file intentionally has no dependency on Qase server internals so the
 * complete `integrations/drytis` directory can be packaged with the Drytis
 * backend. Keep its signature parity test aligned with server/drytisTransport.
 */
export const DRYTIS_INTEGRATION_SCHEMA_VERSION = '2026-08-1';
export const DRYTIS_SIGNATURE_VERSION = 'qase-drytis-hmac-v1';
export const DRYTIS_INBOUND_HEADERS = Object.freeze({
	signature: 'x-drytis-signature',
	timestamp: 'x-drytis-timestamp',
	nonce: 'x-drytis-nonce',
	idempotencyKey: 'idempotency-key',
	correlationId: 'x-correlation-id'
});

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._~:/-]*$/;
const METHODS = /^(?:DELETE|GET|PATCH|POST|PUT)$/;

function boundedToken(value, label, minimum, maximum) {
	if (typeof value !== 'string' || value.length < minimum || value.length > maximum || !TOKEN.test(value)) {
		throw new TypeError(`${label} is invalid.`);
	}
	return value;
}

function normalizeTimestamp(value) {
	const result = String(value);
	if (!/^\d{10,11}$/.test(result) || !Number.isSafeInteger(Number(result))) {
		throw new TypeError('timestamp is invalid.');
	}
	return result;
}

function normalizeMethod(value) {
	const result = String(value ?? '').toUpperCase();
	if (!METHODS.test(result)) throw new TypeError('method is invalid.');
	return result;
}

function normalizeRequestTarget(value) {
	if (typeof value !== 'string' || !value.startsWith('/') || value.length > 8192
		|| value.includes('#') || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new TypeError('requestTarget is invalid.');
	}
	return value;
}

function bodyBytes(value) {
	return Buffer.isBuffer(value) || value instanceof Uint8Array
		? Buffer.from(value)
		: Buffer.from(String(value ?? ''), 'utf8');
}

export function canonicalDrytisRequest({
	signer,
	timestamp,
	nonce,
	idempotencyKey,
	correlationId,
	method,
	requestTarget,
	body
}) {
	if (signer !== 'drytis' && signer !== 'qase') throw new TypeError('signer must be drytis or qase.');
	const digest = createHash('sha256').update(bodyBytes(body)).digest('hex');
	return [
		DRYTIS_SIGNATURE_VERSION,
		signer,
		normalizeTimestamp(timestamp),
		boundedToken(nonce, 'nonce', 16, 128),
		boundedToken(idempotencyKey, 'idempotencyKey', 8, 200),
		boundedToken(correlationId, 'correlationId', 8, 128),
		normalizeMethod(method),
		normalizeRequestTarget(requestTarget),
		digest
	].join('\n');
}

export function signDrytisRequest({ signingKey, ...request }) {
	if (!signingKey) throw new TypeError('A signing key is required.');
	const canonical = canonicalDrytisRequest(request);
	return `v1=${createHmac('sha256', signingKey).update(canonical, 'utf8').digest('hex')}`;
}
