import test from 'node:test';
import assert from 'node:assert/strict';
import { probeTargetReachability } from './targetReachability.js';

const environment = { NODE_ENV: 'production' };
test('private HTTP targets are rejected before any TCP connection', async () => {
	let connected = false;
	const result = await probeTargetReachability('http://127.0.0.1:1234', { environment, tcpProbe: async () => { connected = true; return true; } });
	assert.equal(result.ok, false); assert.equal(connected, false);
	assert.equal(result.reason, 'BROWSER_PRIVATE_NETWORK_BLOCKED');
});
test('mixed public/private DNS responses fail closed', async () => {
	let connected = false;
	const result = await probeTargetReachability('http://target.example', { environment,
		resolveHost: async () => [{ address: '8.8.8.8' }, { address: '10.0.0.1' }],
		tcpProbe: async () => { connected = true; return true; } });
	assert.equal(result.ok, false); assert.equal(connected, false);
});
test('public HTTP connects to its validated IP without resolving a second time', async () => {
	let lookups = 0;
	const result = await probeTargetReachability('http://target.example:8080', { environment,
		resolveHost: async () => { lookups++; return [{ address: '8.8.8.8' }]; },
		tcpProbe: async (host, port) => { assert.equal(host, '8.8.8.8'); assert.equal(port, 8080); return true; } });
	assert.equal(result.ok, true); assert.equal(lookups, 1);
});
test('an explicit private-host allowlist permits a pinned TCP probe', async () => {
	const result = await probeTargetReachability('http://127.0.0.1:8080', {
		environment: { ...environment, QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1' },
		tcpProbe: async (host, port) => { assert.equal(host, '127.0.0.1'); assert.equal(port, 8080); return true; } });
	assert.equal(result.ok, true);
});
