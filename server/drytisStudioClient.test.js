import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	DrytisQaseClientError,
	buildDrytisRepairBundle,
	createDrytisQaseClient
} from '../integrations/drytis/qaseClient.js';
import {
	canonicalDrytisRequest as canonicalPortableRequest,
	signDrytisRequest as signPortableRequest
} from '../integrations/drytis/protocol.js';
import {
	canonicalDrytisRequest as canonicalServerRequest,
	createDrytisRequestVerifier,
	createMemoryDrytisNonceStore,
	signDrytisRequest as signServerRequest
} from './drytisTransport.js';

const KEY = Buffer.alloc(32, 7);
const NOW = 1_787_695_200_000;
const REVIEW_ID = '00000000-0000-4000-8000-000000000101';

function verifiedClient(handler) {
	let sequence = 0;
	const verifier = createDrytisRequestVerifier({
		config: { signingKey: KEY, maxRequestBytes: 16 * 1024 * 1024, maxClockSkewMs: 300_000 },
		nonceStore: createMemoryDrytisNonceStore({ now: () => NOW }),
		now: () => NOW
	});
	const calls = [];
	const client = createDrytisQaseClient({
		qaseOrigin: 'https://qase.drytis.example',
		signingKey: KEY,
		now: () => NOW,
		createUuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
		createNonce: () => `nonce-${String(++sequence).padStart(20, '0')}`,
		fetchImpl: async (url, options) => {
			const rawBody = options.body ? Buffer.from(options.body) : Buffer.alloc(0);
			const verified = await verifier.verify({
				method: options.method,
				requestTarget: `${url.pathname}${url.search}`,
				headers: options.headers,
				rawBody
			});
			calls.push({ url: url.toString(), options, verified, body: rawBody });
			return handler({ url, options, verified, body: rawBody, calls });
		}
	});
	return { client, calls };
}

test('portable Studio protocol remains byte-for-byte compatible with the Qase verifier', () => {
	const request = {
		signer: 'drytis',
		timestamp: String(NOW / 1000),
		nonce: 'nonce-00000000000000000001',
		idempotencyKey: 'create-review-001',
		correlationId: 'correlation-001',
		method: 'POST',
		requestTarget: '/internal/v1/drytis/reviews?contract=1',
		body: Buffer.from('{"exact":"bytes"}', 'utf8')
	};
	assert.equal(canonicalPortableRequest(request), canonicalServerRequest(request));
	assert.equal(
		signPortableRequest({ signingKey: KEY, ...request }),
		signServerRequest({ signingKey: KEY, ...request })
	);
});

test('Drytis backend client signs exact requests and sends the Studio create envelope', async () => {
	const { client, calls } = verifiedClient(({ body }) => new Response(JSON.stringify({
		schemaVersion: '2026-08-1',
		externalReviewId: REVIEW_ID,
		launchUrl: `https://qase.drytis.example/?run=${REVIEW_ID}`,
		status: 'running'
	}), { status: 201, headers: { 'Content-Type': 'application/json' } }));
	const result = await client.createReview({
		schemaVersion: '2026-08-1',
		externalReviewId: REVIEW_ID,
		project: { id: 'project-1', name: 'Studio app', revision: 'commit:123' },
		projectContext: { frameworks: ['React', 'Node.js'] },
		containerUrl: 'https://preview.drytis.example/',
		requestedChecks: { blackBox: true, whiteBox: false }
	}, { idempotencyKey: 'create-review-001', correlationId: 'correlation-001' });

	assert.equal(result.status, 'running');
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://qase.drytis.example/internal/v1/drytis/reviews');
	assert.equal(calls[0].verified.idempotencyKey, 'create-review-001');
	assert.equal(JSON.parse(calls[0].body).containerUrl, 'https://preview.drytis.example/');
	assert.equal(calls[0].options.redirect, 'error');
});

test('toolbar launch descriptors remain pinned to the configured Qase origin', () => {
	const { client } = verifiedClient(() => new Response('{}'));
	const descriptor = client.launchDescriptor({
		launchUrl: `https://qase.drytis.example/?run=${REVIEW_ID}`
	});
	assert.equal(descriptor.title, 'QASE project quality workspace');
	assert.match(descriptor.sandbox, /allow-forms/);
	assert.equal(descriptor.referrerPolicy, 'no-referrer');
	assert.throws(() => client.launchDescriptor({ launchUrl: 'https://attacker.example/qase' }),
		error => error instanceof DrytisQaseClientError && error.code === 'invalid_launch_url');
});

test('client maps bounded Qase errors without exposing an upstream body', async () => {
	const { client } = verifiedClient(() => new Response(JSON.stringify({
		error: { code: 'review_not_found', message: 'No review exists.', retryable: false, correlationId: 'server-correlation' }
	}), { status: 404, headers: { 'Content-Type': 'application/json' } }));
	await assert.rejects(() => client.getReview(REVIEW_ID), error => {
		assert.equal(error.code, 'review_not_found');
		assert.equal(error.status, 404);
		assert.equal(error.correlationId, 'server-correlation');
		assert.equal(error.message, 'No review exists.');
		return true;
	});
});

test('repair bundles stay immutable-revision bound for the Drytis coding agent', () => {
	const bundle = buildDrytisRepairBundle({
		schemaVersion: '2026-08-1',
		externalReviewId: REVIEW_ID,
		qaseRunId: REVIEW_ID,
		status: 'completed',
		project: { id: 'project-1', name: 'Studio app', revision: 'commit:123' },
		summary: { findings: 1 },
		repairTasks: [{
			id: 'repair:one', type: 'white_box', findingId: 'one', severity: 'high',
			revision: 'commit:123', snapshotSha256: `sha256:${'a'.repeat(64)}`,
			path: 'src/app.js', startLine: 12, prompt: 'Apply the narrow repair and run the regression test.'
		}]
	});
	assert.equal(bundle.tasks.length, 1);
	assert.equal(bundle.requiresHumanApproval, true);
	assert.equal(Object.isFrozen(bundle.tasks[0]), true);
	assert.throws(() => buildDrytisRepairBundle({
		status: 'completed',
		project: { id: 'project-1', name: 'Studio app', revision: 'commit:123' },
		repairTasks: [{ id: 'repair:one', revision: 'commit:older', prompt: 'stale' }]
	}), error => error.code === 'invalid_repair_bundle');
});

test('client streams and rejects oversized Qase responses without buffering past its cap', async () => {
	let sequence = 0;
	const client = createDrytisQaseClient({
		qaseOrigin: 'https://qase.drytis.example',
		signingKey: KEY,
		now: () => NOW,
		maxResponseBytes: 1_024,
		createUuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
		createNonce: () => `nonce-${String(++sequence).padStart(20, '0')}`,
		fetchImpl: async () => new Response(`"${'x'.repeat(2_000)}"`, {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		})
	});
	await assert.rejects(() => client.getReview(REVIEW_ID), error => {
		assert.equal(error.code, 'qase_response_too_large');
		assert.match(error.correlationId, /^corr-/);
		return true;
	});
});
