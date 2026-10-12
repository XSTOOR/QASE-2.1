import assert from 'node:assert/strict';
import test from 'node:test';
import { getConfig, getPublicConfig, testConnection, withUserConfiguration } from './config.js';

const CANDIDATE = Object.freeze({
	provider: 'custom', apiKey: 'test-key', baseUrl: 'https://models.openai.com/v1', model: 'quality-model'
});
const PUBLIC_DNS = async () => [{ address: '104.18.33.45', family: 4 }];
const PRODUCTION = Object.freeze({ NODE_ENV: 'production' });

test('user-scope settings inherit env gateway defaults so new users start with a usable key', async () => {
	const saved = { ...process.env };
	const settings = {};
	try {
		process.env.QASE_PROVIDER = 'custom';
		process.env.QASE_API_KEY = 'env-key-1234';
		process.env.QASE_BASE_URL = 'https://llm.drytis.ai';
		process.env.QASE_MODEL = 'env-model';
		await withUserConfiguration(settings, () => {}, async () => {
			// New user: empty settings store → inherits env values.
			assert.equal(getConfig().provider, 'custom');
			assert.equal(getConfig().apiKey, 'env-key-1234');
			assert.equal(getConfig().baseUrl, 'https://llm.drytis.ai');
			assert.equal(getConfig().model, 'env-model');
			const pub = getPublicConfig();
			assert.equal(pub.hasApiKey, true);
			assert.equal(pub.apiKeyHint, '••••1234');
			assert.equal(pub.apiKeyFromEnv, true);
			assert.equal(pub.ready, true);
		});
	} finally {
		for (const key of ['QASE_PROVIDER', 'QASE_API_KEY', 'QASE_BASE_URL', 'QASE_MODEL']) {
			if (key in saved) process.env[key] = saved[key]; else delete process.env[key];
		}
	}
});

test('user-scope settings that were explicitly saved override env values', async () => {
	const saved = { ...process.env };
	try {
		process.env.QASE_API_KEY = 'env-key-1234';
		await withUserConfiguration({ apiKey: 'user-key-9999', model: 'user-model' }, () => {}, async () => {
			assert.equal(getConfig().apiKey, 'user-key-9999');
			assert.equal(getConfig().model, 'user-model');
			const pub = getPublicConfig();
			assert.equal(pub.apiKeyHint, '••••9999');
			assert.equal(pub.apiKeyFromEnv, false);
		});
	} finally {
		if ('QASE_API_KEY' in saved) process.env.QASE_API_KEY = saved.QASE_API_KEY; else delete process.env.QASE_API_KEY;
	}
});

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
	const requests = [];
	const result = await testConnection(CANDIDATE, options({
		timeoutMs: 60_000,
		createTimeoutSignal(timeoutMs) {
			assert.equal(timeoutMs, 30_000);
			return new AbortController().signal;
		},
		fetchImpl: async (url, init) => {
			requests.push({ url: String(url), init });
			if (String(url).endsWith('/models')) {
				return new Response(JSON.stringify({ data: [{ id: 'quality-model' }, { id: 'backup-model' }] }), {
					status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }
				});
			}
			return new Response('data: {"choices":[{"delta":{"content":"ready"}}]}', {
				status: 200, headers: { 'content-type': 'text/event-stream' }
			});
		}
	}));
	assert.equal(result.ok, true);
	assert.equal(result.matched, true);
	assert.deepEqual(result.models, ['quality-model', 'backup-model']);
	const listing = requests.find(entry => entry.url === 'https://models.openai.com/v1/models');
	assert.ok(listing, 'listing request was made');
	assert.equal(listing.init.redirect, 'error');
	assert.equal(listing.init.headers.Authorization, 'Bearer test-key');
});

// Completion verification: a gateway that LISTS the model must also ACCEPT a
// completion for it before `matched` is reported true. The drytis gateway
// listed drytis/jev-1.13 in /v1/models but rejected it at /chat/completions,
// and the listing-only probe reported a false positive.

function listingFetch(models = ['quality-model']) {
	const listing = new Response(JSON.stringify({ data: models.map(id => ({ id })) }), {
		status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }
	});
	return async (url, init = {}) => {
		if (String(url).endsWith('/models')) {
			return listing.clone();
		}
		return { url, init, __unmatched: true };
	};
}

test('model probe verifies a listed model accepts a completion before reporting matched', async () => {
	const requests = [];
	const result = await testConnection(CANDIDATE, options({
		fetchImpl: async (url, init) => {
			requests.push({ url: String(url), method: init.method });
			if (String(url).endsWith('/models')) {
				return new Response(JSON.stringify({ data: [{ id: 'quality-model' }] }), {
					status: 200, headers: { 'content-type': 'application/json' }
				});
			}
			assert.equal(String(url), 'https://models.openai.com/v1/chat/completions');
			assert.equal(init.method, 'POST');
			const body = JSON.parse(init.body);
			assert.equal(body.model, 'quality-model');
			assert.equal(body.stream, true);
			return new Response('data: {"choices":[{"delta":{"content":"ready"}}]}', {
				status: 200, headers: { 'content-type': 'text/event-stream' }
			});
		}
	}));
	assert.equal(result.ok, true);
	assert.equal(result.matched, true);
	assert.equal(result.completionVerified, true);
	assert.equal(requests.length, 2);
	assert.equal(requests[0].method, undefined); // GET listing
	assert.equal(requests[1].method, 'POST'); // POST completion probe
});

test('model probe downgrades matched when a listed model rejects the completion (drytis/jev-1.13 case)', async () => {
	const result = await testConnection(
		{ ...CANDIDATE, model: 'drytis/jev-1.13' },
		options({
			fetchImpl: async url => {
				if (String(url).endsWith('/models')) {
					return new Response(JSON.stringify({ data: [{ id: 'drytis/jev-1.13' }] }), {
						status: 200, headers: { 'content-type': 'application/json' }
					});
				}
				return new Response(JSON.stringify({
					error: { message: '/chat/completions: Invalid model name passed in model=drytis/jev-1.13.' }
				}), { status: 400, headers: { 'content-type': 'application/json' } });
			}
		})
	);
	assert.equal(result.ok, true);
	assert.equal(result.matched, false);
	assert.equal(result.completionVerified, false);
	assert.match(result.message, /lists the model, but a test completion was rejected/);
	assert.match(result.message, /Invalid model name passed in model=drytis\/jev-1\.13/);
	// Still reachable — the gateway itself is fine.
	assert.deepEqual(result.models, ['drytis/jev-1.13']);
});

test('model probe keeps the listing verdict when the completion endpoint is unsupported', async () => {
	const result = await testConnection(CANDIDATE, options({
		fetchImpl: async url => {
			if (String(url).endsWith('/models')) {
				return new Response(JSON.stringify({ data: [{ id: 'quality-model' }] }), {
					status: 200, headers: { 'content-type': 'application/json' }
				});
			}
			return new Response('Not Found', { status: 404 });
		}
	}));
	assert.equal(result.ok, true);
	assert.equal(result.matched, true);
	assert.equal(result.completionVerified, undefined);
});

test('model probe downgrades matched when the key is rejected for completions', async () => {
	const result = await testConnection(CANDIDATE, options({
		fetchImpl: async url => {
			if (String(url).endsWith('/models')) {
				return new Response(JSON.stringify({ data: [{ id: 'quality-model' }] }), {
					status: 200, headers: { 'content-type': 'application/json' }
				});
			}
			return new Response(JSON.stringify({ error: { message: 'Forbidden for this model' } }), {
				status: 403, headers: { 'content-type': 'application/json' }
			});
		}
	}));
	assert.equal(result.ok, true);
	assert.equal(result.matched, false);
	assert.match(result.message, /key was rejected for a test completion \(HTTP 403\)/);
});

test('model probe tolerates completion-probe transport failures and keeps the listing verdict', async () => {
	const result = await testConnection(CANDIDATE, options({
		fetchImpl: async url => {
			if (String(url).endsWith('/models')) {
				return new Response(JSON.stringify({ data: [{ id: 'quality-model' }] }), {
					status: 200, headers: { 'content-type': 'application/json' }
				});
			}
			throw new TypeError('fetch failed', { cause: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }) });
		}
	}));
	assert.equal(result.ok, true);
	assert.equal(result.matched, true);
	assert.equal(result.completionVerified, undefined);
});

test('model probe skips completion verification when the model is not listed', async () => {
	let calls = 0;
	const result = await testConnection(CANDIDATE, options({
		fetchImpl: async url => {
			calls++;
			if (String(url).endsWith('/models')) {
				return new Response(JSON.stringify({ data: [{ id: 'other-model' }] }), {
					status: 200, headers: { 'content-type': 'application/json' }
				});
			}
			throw new Error('completion probe must not run');
		}
	}));
	assert.equal(result.ok, true);
	assert.equal(result.matched, false);
	assert.equal(calls, 1);
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

test('private-network probes are blocked in development unless explicitly opted in', async () => {
	let called = false;
	const opts = extra => options({
		...extra,
		dnsLookup: async () => { throw new Error('Direct IP addresses must not require DNS.'); },
		fetchImpl: async () => {
			called = true;
			return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
		}
	});
	const blocked = await testConnection({
		...CANDIDATE, baseUrl: 'http://127.0.0.1:4000/v1'
	}, opts({ environment: { NODE_ENV: 'development' } }));
	assert.equal(blocked.ok, false);
	assert.match(blocked.error, /public network destination/);

	const allowed = await testConnection({
		...CANDIDATE, baseUrl: 'http://127.0.0.1:16000/v1'
	}, opts({ environment: { NODE_ENV: 'development', QASE_ALLOW_PRIVATE_NETWORK: 'true' } }));
	assert.equal(allowed.ok, true);
	assert.equal(called, true);

	for (const nodeEnv of ['staging', 'Production', '']) {
		called = false;
		const guarded = await testConnection({
			...CANDIDATE, baseUrl: 'https://127.0.0.1:16000/v1'
		}, opts({ environment: { NODE_ENV: nodeEnv, QASE_ALLOW_PRIVATE_NETWORK: 'true' } }));
		assert.equal(guarded.ok, false, `private-network opt-out must be ignored for NODE_ENV=${JSON.stringify(nodeEnv)}`);
		assert.match(guarded.error, /public network destination/);
		assert.equal(called, false);
	}
});
