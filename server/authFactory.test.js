import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredAuthenticationMode, createConfiguredAuthentication } from './authFactory.js';

test('authentication selection defaults to local and rejects unknown modes', () => {
	assert.equal(configuredAuthenticationMode({}), 'local');
	assert.equal(configuredAuthenticationMode({ QASE_AUTH_MODE: ' DRYTIS ' }), 'drytis');
	assert.throws(() => configuredAuthenticationMode({ QASE_AUTH_MODE: 'oauth-ish' }), /local, drytis/);
});

test('local authentication construction does not require PostgreSQL', () => {
	const local = { mount() {}, isSessionActive() {} };
	const result = createConfiguredAuthentication({ createLocal: () => local });
	assert.deepEqual(result, { mode: 'local', authentication: local });
});

test('Drytis authentication requires PostgreSQL and receives only trusted infrastructure', () => {
	assert.throws(() => createConfiguredAuthentication({
		environment: { QASE_AUTH_MODE: 'drytis' }, runStoreMode: 'local'
	}), /requires QASE_RUN_STORE=postgres/);
	const pool = {};
	const tenantContext = Object.freeze({ organizationId: 'org', projectId: 'project' });
	const repository = {};
	const authentication = {};
	const result = createConfiguredAuthentication({
		environment: { QASE_AUTH_MODE: 'drytis' }, runStoreMode: 'postgres', pool, tenantContext,
		createRepository: options => { assert.deepEqual(options, { pool }); return repository; },
		createDrytis: options => {
			assert.equal(options.repository, repository);
			assert.equal(options.tenantContext, tenantContext);
			return authentication;
		}
	});
	assert.deepEqual(result, { mode: 'drytis', authentication });
});
