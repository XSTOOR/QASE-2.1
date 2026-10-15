import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunKeepalive, isRunStatusActive, hostnameOf, resolvePublicIp } from './keepalive.js';

function harness(overrides = {}) {
	const calls = [];
	const keepalive = createRunKeepalive({
		intervalMs: 10,
		quietAfterMs: 25,
		getUrl: () => 'http://127.0.0.1:5173/healthz',
		fetchImpl: async url => {
			const target = String(url);
			if (target.includes('dns.google')) {
				return new Response(JSON.stringify({ Status: 0, Answer: [] }), { status: 200 });
			}
			calls.push(target);
			return new Response('ok');
		},
		logger: { warn() {}, info() {} },
		...overrides
	});
	return { keepalive, calls };
}

test('idle keepalive never pings', async () => {
	const { calls } = harness();
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.deepEqual(calls, []);
});

test('keepalive pings healthz while a run is active and stops after quiet period', async () => {
	const { keepalive, calls } = harness();
	keepalive.noteActive();
	await new Promise(resolve => setTimeout(resolve, 60));
	assert.ok(calls.length >= 1, 'expected at least one ping while active');
	// The DoH lookup for an IP literal returns no A record, so every actual
	// ping must be the plain URL fallback to /healthz.
	assert.ok(calls.every(url => !String(url).includes('dns.google')), 'no DoH calls counted as pings');
	assert.ok(calls.every(url => url.endsWith('/healthz')), 'all pings target healthz');
	// Let the quiet window (25ms) pass; no further pings should occur.
	const before = calls.length;
	await new Promise(resolve => setTimeout(resolve, 60));
	assert.equal(calls.length, before, 'pings must stop after the quiet period');
	keepalive.stop();
});

test('keepalive swallows fetch failures without unhandled rejections', async () => {
	const warnings = [];
	const { keepalive } = harness({
		fetchImpl: async () => { throw new TypeError('fetch failed'); },
		logger: { warn: (event, meta) => warnings.push([event, meta]), info() {} }
	});
	keepalive.noteActive();
	await new Promise((resolve, reject) => {
		process.on('unhandledRejection', reject);
		setTimeout(resolve, 35);
	});
	assert.ok(warnings.length >= 1, 'failure was logged, not thrown');
	keepalive.stop();
});

test('stop clears the timer permanently', async () => {
	const { keepalive, calls } = harness();
	keepalive.noteActive();
	await new Promise(resolve => setTimeout(resolve, 25));
	keepalive.stop();
	const before = calls.length;
	keepalive.noteActive();
	await new Promise(resolve => setTimeout(resolve, 30));
	assert.equal(calls.length, before, 'no pings after stop even if noteActive is called');
});

test('hostnameOf extracts hostnames and rejects junk', () => {
	assert.equal(hostnameOf('https://qase.example.dev/healthz'), 'qase.example.dev');
	assert.equal(hostnameOf('http://127.0.0.1:5173/healthz'), '127.0.0.1');
	assert.equal(hostnameOf('not a url'), null);
});

test('resolvePublicIp returns the first A record from DoH', async () => {
	const fetchImpl = async url => {
		assert.match(url, /dns\.google/);
		assert.match(url, /name=example\.dev/);
		return new Response(JSON.stringify({
			Status: 0,
			Answer: [
				{ name: 'example.dev.', type: 5, data: 'edge.example.dev.' },
				{ name: 'example.dev.', type: 1, data: '203.0.113.7' }
			]
		}), { status: 200 });
	};
	assert.equal(await resolvePublicIp('example.dev', { fetchImpl }), '203.0.113.7');
});

test('resolvePublicIp tolerates DoH failure and empty answers', async () => {
	assert.equal(await resolvePublicIp('example.dev', {
		fetchImpl: async () => { throw new Error('offline'); }
	}), null);
	assert.equal(await resolvePublicIp('example.dev', {
		fetchImpl: async () => new Response(JSON.stringify({ Status: 0, Answer: [] }), { status: 200 })
	}), null);
	assert.equal(await resolvePublicIp('example.dev', {
		fetchImpl: async () => new Response('nope', { status: 500 })
	}), null);
});

test('public IP resolution failure falls back to plain URL ping', async () => {
	const { keepalive, calls } = harness({
		getUrl: () => 'https://site.example.dev/healthz',
		fetchImpl: async url => {
			if (String(url).includes('dns.google')) throw new Error('offline');
			calls.push(url);
			return new Response('ok');
		}
	});
	keepalive.noteActive();
	await new Promise(resolve => setTimeout(resolve, 80));
	assert.ok(calls.length >= 1, 'fallback ping fired');
	assert.ok(calls.every(url => String(url).endsWith('/healthz')));
	keepalive.stop();
});

test('isActive predicate keeps pinging when the bus has been quiet', async () => {
	const pings = [];
	let running = true;
	const { keepalive } = harness({
		getUrl: () => 'http://127.0.0.1:5173/healthz',
		isActive: () => running,
		fetchImpl: async url => {
			if (String(url).includes('dns.google')) {
				return new Response(JSON.stringify({ Status: 0, Answer: [] }), { status: 200 });
			}
			pings.push(String(url));
			return new Response('ok');
		}
	});
	keepalive.noteActive();
	// Long after the quiet window (25ms), the predicate still reports a live
	// run, so pings must continue.
	await new Promise(resolve => setTimeout(resolve, 90));
	assert.ok(pings.length >= 2, `expected pings past the quiet window, got ${pings.length}`);
	running = false;
	// Wait past the quiet window (25ms) so a tick runs with the predicate off
	// and stops the timer; then verify NO further pings arrive over a window
	// that is long enough for several missed intervals.
	await new Promise(resolve => setTimeout(resolve, 60));
	const before = pings.length;
	await new Promise(resolve => setTimeout(resolve, 80));
	assert.equal(pings.length, before, 'pings stop once the predicate reports no live run');
	keepalive.stop();
});

test('active run statuses are recognized', () => {
	assert.equal(isRunStatusActive('running'), true);
	assert.equal(isRunStatusActive('awaiting_input'), true);
	assert.equal(isRunStatusActive('idle'), false);
	assert.equal(isRunStatusActive('done'), false);
	assert.equal(isRunStatusActive('interrupted'), false);
	assert.equal(isRunStatusActive('error'), false);
});
