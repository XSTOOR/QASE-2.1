import assert from 'node:assert/strict';
import test from 'node:test';
import { testConnection } from './config.js';

const CANDIDATE = Object.freeze({
	provider: 'custom', apiKey: 'test-key', baseUrl: 'https://models.openai.com/v1', model: 'quality-model'
});
const PUBLIC_DNS = async () => [{ address: '104.18.33.45', family: 4 }];
const PRODUCTION = Object.freeze({ NODE_ENV: 'production' });

test('model probe explains nested transport failures without exposing cause details', async () => {
	for (const [code, expected] of [
		['EACCES', /Outbound network access is denied/],
		['EPERM', /Outbound network access is denied/],
		['ENOTFOUND', /hostname could not be resolved/],
		['ECONNREFUSED', /refused the connection/],
		['UND_ERR_CONNECT_TIMEOUT', /timed out/]
	]) {
		const cause = Object.assign(new Error('private credential detail'), { code });
		const result = await testConnection(CANDIDATE, options({
			fetchImpl: async () => { throw new TypeError('fetch failed', { cause: new AggregateError([cause]) }); }
		}));
		assert.equal(result.ok, false);
		assert.match(result.error, expected);
		assert.doesNotMatch(result.error, /private credential detail|test-key/);
	}
});

function options(overrides = {}) {
	return {
		environment: PRODUCTION,
		dnsLookup: PUBLIC_DNS,
		createTimeoutSignal: () => new AbortController().signal,
		...overrides
	};
}

test('model probe requires HTTPS and rejects URL credentials, queries, and fragments in production', async () => {
	let calls = 0;
	const fetchImpl = async () => { calls++; return new Response('{}'); };
	for (const baseUrl of [
		'http://models.openai.com/v1',
		'https://user:secret@models.openai.com/v1',
		'https://models.openai.com/v1?destination=internal',
		'https://models.openai.com/v1#fragment'
	]) {
		const result = await testConnection({ ...CANDIDATE, baseUrl }, options({ fetchImpl }));
		assert.equal(result.ok, false);
	}
	assert.equal(calls, 0);
});

test('model probe blocks direct and DNS-resolved non-public destinations in production', async () => {
	let calls = 0;
	const fetchImpl = async () => { calls++; return new Response('{}'); };
	for (const baseUrl of [
		'https://127.0.0.1/v1',
		'https://169.254.169.254/latest',
		'https://10.0.0.8/v1',
		'https://[::1]/v1',
		'https://[fc00::1]/v1'
	]) {
		const result = await testConnection({ ...CANDIDATE, baseUrl }, options({ fetchImpl }));
		assert.equal(result.ok, false, baseUrl);
		assert.match(result.error, /public network destination/);
	}
	const rebinding = await testConnection(CANDIDATE, options({
		fetchImpl,
		dnsLookup: async () => [
			{ address: '104.18.33.45', family: 4 },
			{ address: '192.168.1.10', family: 4 }
		]
	}));
	assert.equal(rebinding.ok, false);
	assert.equal(calls, 0);
});

test('model probe refuses redirects, sends the credential only after validation, and bounds timeout', async () => {
	let request;
	const result = await testConnection(CANDIDATE, options({
		timeoutMs: 60_000,
		createTimeoutSignal(timeoutMs) {
			assert.equal(timeoutMs, 30_000);
			return new AbortController().signal;
		},
		fetchImpl: async (url, init) => {
			request = { url, init };
			return new Response(JSON.stringify({ data: [{ id: 'quality-model' }, { id: 'backup-model' }] }), {
				status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }
			});
		}
	}));
	assert.equal(result.ok, true);
	assert.equal(result.matched, true);
	assert.deepEqual(result.models, ['quality-model', 'backup-model']);
	assert.equal(request.url, 'https://models.openai.com/v1/models');
	assert.equal(request.init.redirect, 'error');
	assert.equal(request.init.headers.Authorization, 'Bearer test-key');
});

test('model probe accepts JSON only and enforces declared and streamed body limits', async () => {
	const nonJson = await testConnection(CANDIDATE, options({
		fetchImpl: async () => new Response('<html>not json</html>', {
			headers: { 'content-type': 'text/html' }
		})
	}));
	assert.equal(nonJson.ok, false);
	assert.match(nonJson.error, /did not return JSON/);

	const declared = await testConnection(CANDIDATE, options({
		maxResponseBytes: 1024,
		fetchImpl: async () => new Response('{}', {
			headers: { 'content-type': 'application/json', 'content-length': '2048' }
		})
	}));
	assert.equal(declared.ok, false);
	assert.match(declared.error, /too large/);

	const streamed = await testConnection(CANDIDATE, options({
		maxResponseBytes: 1024,
		fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'x'.repeat(2048) }] }), {
			headers: { 'content-type': 'application/json' }
		})
	}));
	assert.equal(streamed.ok, false);
	assert.match(streamed.error, /too large/);
});

test('development may probe a local HTTP gateway without weakening production defaults', async () => {
	let called = false;
	const result = await testConnection({
		...CANDIDATE, baseUrl: 'http://127.0.0.1:4000/v1'
	}, options({
		environment: { NODE_ENV: 'development' },
		dnsLookup: async () => { throw new Error('Direct IP addresses must not require DNS.'); },
		fetchImpl: async () => {
			called = true;
			return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
		}
	}));
	assert.equal(result.ok, true);
	assert.equal(called, true);
});
