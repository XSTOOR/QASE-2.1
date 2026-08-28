import assert from 'node:assert/strict';
import { createSecretKey } from 'node:crypto';
import test from 'node:test';
import {
	DRYTIS_INBOUND_HEADERS,
	DRYTIS_OUTBOUND_HEADERS,
	DrytisTransportError,
	canonicalDrytisRequest,
	createDrytisDeliveryClient,
	createDrytisRequestVerifier,
	createMemoryDrytisNonceStore,
	signDrytisRequest
} from './drytisTransport.js';

const NOW = Date.parse('2026-08-19T00:00:00.000Z');
const TIMESTAMP = String(Math.floor(NOW / 1000));
const KEY_BYTES = Buffer.alloc(32, 0x51);
const KEY = createSecretKey(KEY_BYTES);
const CONFIG = Object.freeze({
	apiOrigin: 'https://api.drytis.com',
	allowedOrigins: Object.freeze(['https://api.drytis.com', 'https://events.drytis.com']),
	signingKey: KEY,
	timeoutMs: 5000,
	maxRequestBytes: 1024,
	maxResponseBytes: 1024,
	maxClockSkewMs: 300_000
});

function inbound(overrides = {}) {
	const request = {
		signer: 'drytis',
		timestamp: TIMESTAMP,
		nonce: 'nonce-value-1234567890',
		idempotencyKey: 'project-42/revision-7',
		correlationId: 'correlation-12345678',
		method: 'POST',
		requestTarget: '/v1/integrations/qase/runs?mode=qa',
		body: Buffer.from('{"projectId":"project-42"}'),
		...overrides
	};
	const headers = {
		[DRYTIS_INBOUND_HEADERS.timestamp]: request.timestamp,
		[DRYTIS_INBOUND_HEADERS.nonce]: request.nonce,
		[DRYTIS_INBOUND_HEADERS.idempotencyKey]: request.idempotencyKey,
		[DRYTIS_INBOUND_HEADERS.correlationId]: request.correlationId,
		[DRYTIS_INBOUND_HEADERS.signature]: signDrytisRequest({ signingKey: KEY, ...request })
	};
	return { ...request, headers, rawBody: request.body };
}

test('canonical HMAC binds signer, timestamp, nonce, idempotency, correlation, method, target, and body digest', () => {
	const request = inbound();
	const canonical = canonicalDrytisRequest(request);
	assert.match(canonical, /^qase-drytis-hmac-v1\ndrytis\n/);
	assert.match(canonical, /\nPOST\n\/v1\/integrations\/qase\/runs\?mode=qa\n[0-9a-f]{64}$/);
	assert.equal(signDrytisRequest({ signingKey: KEY, ...request }), request.headers[DRYTIS_INBOUND_HEADERS.signature]);
	for (const patch of [
		{ signer: 'qase' }, { timestamp: String(Number(TIMESTAMP) + 1) },
		{ nonce: 'different-nonce-123456' }, { idempotencyKey: 'project-42/revision-8' },
		{ correlationId: 'different-correlation' }, { method: 'PUT' },
		{ requestTarget: '/v1/integrations/qase/runs?mode=sqa' },
		{ body: Buffer.from('{"projectId":"project-43"}') }
	]) {
		assert.notEqual(signDrytisRequest({ signingKey: KEY, ...request, ...patch }),
			request.headers[DRYTIS_INBOUND_HEADERS.signature]);
	}
});

test('inbound verifier authenticates raw bytes and reserves a hashed nonce after signature verification', async () => {
	const reservations = [];
	const verifier = createDrytisRequestVerifier({
		config: CONFIG, now: () => NOW,
		nonceStore: { async consume(key, expiresAt) { reservations.push({ key, expiresAt }); return true; } }
	});
	const request = inbound();
	const result = await verifier.verify(request);
	assert.equal(result.idempotencyKey, request.idempotencyKey);
	assert.equal(result.correlationId, request.correlationId);
	assert.equal(result.timestamp, '2026-08-19T00:00:00.000Z');
	assert.match(result.bodyDigest, /^[0-9a-f]{64}$/);
	assert.match(reservations[0].key, /^[0-9a-f]{64}$/);
	assert.equal(reservations[0].key.includes(request.nonce), false);
	assert.equal(reservations[0].expiresAt, NOW + CONFIG.maxClockSkewMs + 1000);
});

test('inbound verifier rejects tampering before the nonce store and handles malformed signatures safely', async () => {
	let reservations = 0;
	const verifier = createDrytisRequestVerifier({
		config: CONFIG, now: () => NOW,
		nonceStore: { async consume() { reservations++; return true; } }
	});
	const original = inbound();
	for (const patch of [
		{ method: 'PUT' },
		{ requestTarget: `${original.requestTarget}&admin=true` },
		{ rawBody: Buffer.from('{"projectId":"other"}') },
		{ headers: { ...original.headers, [DRYTIS_INBOUND_HEADERS.idempotencyKey]: 'different-idempotency' } },
		{ headers: { ...original.headers, [DRYTIS_INBOUND_HEADERS.correlationId]: 'different-correlation' } },
		{ headers: { ...original.headers, [DRYTIS_INBOUND_HEADERS.signature]: 'v1=xyz' } }
	]) {
		await assert.rejects(verifier.verify({ ...original, ...patch }), error =>
			error instanceof DrytisTransportError && error.code === 'invalid_signature');
	}
	assert.equal(reservations, 0);
	await assert.rejects(verifier.verify({ ...original, rawBody: JSON.parse(original.rawBody) }),
		/raw bytes/);
});

test('inbound verifier enforces clock skew, request size, replay protection, and nonce-store availability', async () => {
	const request = inbound();
	const nonceStore = createMemoryDrytisNonceStore({ now: () => NOW, maxEntries: 100 });
	const verifier = createDrytisRequestVerifier({ config: CONFIG, now: () => NOW, nonceStore });
	await verifier.verify(request);
	await assert.rejects(verifier.verify(request), error => error.code === 'replayed_signed_request' && error.status === 409);

	const stale = inbound({ timestamp: String(Number(TIMESTAMP) - 301) });
	await assert.rejects(verifier.verify(stale), error => error.code === 'stale_signed_request');
	const oversized = inbound({ body: Buffer.alloc(CONFIG.maxRequestBytes + 1) });
	await assert.rejects(verifier.verify(oversized), error => error.code === 'request_too_large' && error.status === 413);

	const unavailable = createDrytisRequestVerifier({
		config: CONFIG, now: () => NOW,
		nonceStore: { async consume() { throw new Error('redis://user:secret@internal/'); } }
	});
	await assert.rejects(unavailable.verify(inbound({ nonce: 'another-nonce-123456789' })), error =>
		error.code === 'nonce_store_unavailable' && !error.message.includes('secret'));
});

test('memory nonce store prunes expired reservations and is bounded', async () => {
	let time = NOW;
	const store = createMemoryDrytisNonceStore({ now: () => time, maxEntries: 100 });
	const key = 'a'.repeat(64);
	assert.equal(await store.consume(key, time + 1000), true);
	assert.equal(await store.consume(key, time + 1000), false);
	assert.equal(store.size(), 1);
	time += 1001;
	assert.equal(store.size(), 0);
	assert.equal(await store.consume(key, time + 1000), true);
});

test('outbound client signs exact JSON bytes and sends required delivery controls without redirects', async () => {
	let observed;
	const client = createDrytisDeliveryClient({
		config: CONFIG, now: () => NOW, createNonce: () => 'outbound-nonce-123456789',
		createTimeoutSignal(timeout) {
			assert.equal(timeout, CONFIG.timeoutMs);
			return new AbortController().signal;
		},
		async fetchImpl(url, options) {
			observed = { url, options };
			return new Response('{"receiptId":"receipt-1"}', {
				status: 202, headers: { 'content-type': 'application/json' }
			});
		}
	});
	const payload = { event: 'qase.run.completed', runId: 'run-123' };
	const result = await client.deliver('/v1/qase/events?source=integration', payload, {
		idempotencyKey: 'run-123/completed', correlationId: 'correlation-12345678'
	});
	assert.equal(observed.url, 'https://api.drytis.com/v1/qase/events?source=integration');
	assert.equal(observed.options.method, 'POST');
	assert.equal(observed.options.redirect, 'error');
	assert.equal(observed.options.headers[DRYTIS_OUTBOUND_HEADERS.idempotencyKey], 'run-123/completed');
	assert.equal(observed.options.headers[DRYTIS_OUTBOUND_HEADERS.correlationId], 'correlation-12345678');
	assert.equal(observed.options.headers[DRYTIS_OUTBOUND_HEADERS.nonce], 'outbound-nonce-123456789');
	assert.equal(observed.options.headers[DRYTIS_OUTBOUND_HEADERS.signature], signDrytisRequest({
		signingKey: KEY, signer: 'qase', timestamp: TIMESTAMP, nonce: 'outbound-nonce-123456789',
		idempotencyKey: 'run-123/completed', correlationId: 'correlation-12345678', method: 'POST',
		requestTarget: '/v1/qase/events?source=integration', body: Buffer.from(JSON.stringify(payload))
	}));
	assert.deepEqual(result, {
		status: 202, body: { receiptId: 'receipt-1' }, correlationId: 'correlation-12345678'
	});
});

test('outbound client rejects unallowlisted, insecure, credentialed, and fragment destinations before fetch', async () => {
	let calls = 0;
	const client = createDrytisDeliveryClient({ config: CONFIG, fetchImpl: async () => { calls++; } });
	const metadata = { idempotencyKey: 'idempotency-123', correlationId: 'correlation-123' };
	for (const target of [
		'http://api.drytis.com/v1/events',
		'https://evil.example/v1/events',
		'//evil.example/v1/events',
		'https://user:password@api.drytis.com/v1/events',
		'https://api.drytis.com/v1/events#fragment'
	]) {
		await assert.rejects(client.deliver(target, { event: 'test' }, metadata),
			error => error.code === 'destination_not_allowed');
	}
	assert.equal(calls, 0);
});

test('outbound client bounds payloads and responses and never reflects upstream bodies or secrets', async () => {
	const metadata = { idempotencyKey: 'idempotency-123', correlationId: 'correlation-123' };
	const oversizedClient = createDrytisDeliveryClient({
		config: CONFIG,
		fetchImpl: async () => new Response(JSON.stringify({ value: 'x'.repeat(2048) }), {
			status: 200, headers: { 'content-type': 'application/json' }
		})
	});
	await assert.rejects(oversizedClient.deliver('/v1/events', { event: 'x'.repeat(2048) }, metadata),
		error => error.code === 'request_too_large');
	await assert.rejects(oversizedClient.deliver('/v1/events', { event: 'test' }, metadata),
		error => error.code === 'upstream_response_too_large');

	const rejected = createDrytisDeliveryClient({
		config: CONFIG,
		fetchImpl: async () => new Response('{"apiKey":"must-never-escape"}', {
			status: 500, headers: { 'content-type': 'application/json' }
		})
	});
	await assert.rejects(rejected.deliver('/v1/events', { event: 'test' }, metadata), error =>
		error.code === 'delivery_rejected' && error.upstreamStatus === 500
		&& !error.message.includes('must-never-escape'));

	const failed = createDrytisDeliveryClient({
		config: CONFIG,
		fetchImpl: async () => { throw new Error('Authorization: Bearer secret-token-value https://user:pass@api.drytis.com/path?token=secret'); }
	});
	await assert.rejects(failed.deliver('/v1/events', { event: 'test' }, metadata), error =>
		error.code === 'delivery_failed' && !error.message.includes('secret-token-value')
		&& !error.message.includes('token=secret') && !error.message.includes('user:pass'));
});

