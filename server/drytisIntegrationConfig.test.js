import assert from 'node:assert/strict';
import test from 'node:test';
import { createDrytisIntegrationConfig } from './drytisIntegrationConfig.js';

const KEY = Buffer.alloc(32, 0x42).toString('base64url');

function environment(overrides = {}) {
	return {
		QASE_DRYTIS_API_ORIGIN: 'https://api.drytis.com',
		QASE_DRYTIS_ALLOWED_ORIGINS: 'https://api.drytis.com,https://events.drytis.com:8443',
		QASE_DRYTIS_HMAC_KEY: KEY,
		...overrides
	};
}

test('Drytis integration config is strict, bounded, immutable, and does not serialize key material', () => {
	const config = createDrytisIntegrationConfig(environment({
		QASE_DRYTIS_TIMEOUT_MS: '2500',
		QASE_DRYTIS_MAX_REQUEST_BYTES: '4096',
		QASE_DRYTIS_MAX_RESPONSE_BYTES: '2048',
		QASE_DRYTIS_MAX_CLOCK_SKEW_SECONDS: '60'
	}));
	assert.equal(config.apiOrigin, 'https://api.drytis.com');
	assert.deepEqual(config.allowedOrigins, ['https://api.drytis.com', 'https://events.drytis.com:8443']);
	assert.equal(config.timeoutMs, 2500);
	assert.equal(config.maxRequestBytes, 4096);
	assert.equal(config.maxResponseBytes, 2048);
	assert.equal(config.maxClockSkewMs, 60_000);
	assert.equal(Object.isFrozen(config), true);
	assert.equal(Object.isFrozen(config.allowedOrigins), true);
	assert.equal(JSON.stringify(config).includes(KEY), false);
});

test('Drytis integration config rejects weak keys and non-HTTPS or non-origin destinations', () => {
	for (const value of ['', 'short', Buffer.alloc(31).toString('base64url'), `${KEY}=`]) {
		assert.throws(() => createDrytisIntegrationConfig(environment({ QASE_DRYTIS_HMAC_KEY: value })),
			/QASE_DRYTIS_HMAC_KEY/);
	}
	for (const value of [
		'http://api.drytis.com',
		'https://user:password@api.drytis.com',
		'https://api.drytis.com/v1',
		'https://api.drytis.com?next=https://internal.invalid',
		'https://api.drytis.com#fragment'
	]) {
		assert.throws(() => createDrytisIntegrationConfig(environment({ QASE_DRYTIS_API_ORIGIN: value })),
			/exact HTTPS origin/);
	}
});

test('Drytis integration config requires the API origin in an exact allowlist', () => {
	assert.throws(() => createDrytisIntegrationConfig(environment({
		QASE_DRYTIS_ALLOWED_ORIGINS: 'https://drytis.com'
	})), /must be present/);
	assert.throws(() => createDrytisIntegrationConfig(environment({
		QASE_DRYTIS_ALLOWED_ORIGINS: 'https://api.drytis.com, https://events.drytis.com'
	})), /comma-separated exact HTTPS origins/);
	assert.throws(() => createDrytisIntegrationConfig(environment({
		QASE_DRYTIS_ALLOWED_ORIGINS: 'https://*.drytis.com'
	})), /exact HTTPS origin/);
});

test('Drytis integration numeric controls reject coercion, unsafe values, and oversized limits', () => {
	for (const [name, value] of [
		['QASE_DRYTIS_TIMEOUT_MS', '10'],
		['QASE_DRYTIS_TIMEOUT_MS', '1e3'],
		['QASE_DRYTIS_MAX_REQUEST_BYTES', '999'],
		['QASE_DRYTIS_MAX_REQUEST_BYTES', `${17 * 1024 * 1024}`],
		['QASE_DRYTIS_MAX_RESPONSE_BYTES', `${6 * 1024 * 1024}`],
		['QASE_DRYTIS_MAX_CLOCK_SKEW_SECONDS', '901']
	]) {
		assert.throws(() => createDrytisIntegrationConfig(environment({ [name]: value })), new RegExp(name));
	}
});
