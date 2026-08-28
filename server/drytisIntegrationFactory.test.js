import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createConfiguredDrytisIntegration,
	drytisIntegrationEnabled
} from './drytisIntegrationFactory.js';

const TENANT = Object.freeze({
	organizationId: '55c15025-8ef4-4ce8-8ad5-4562f33f1852',
	projectId: 'f2964599-fb3a-4c4e-acec-ee84d74fab55'
});

test('Drytis data-plane activation is explicit and disabled by default', () => {
	assert.equal(drytisIntegrationEnabled({}), false);
	assert.equal(drytisIntegrationEnabled({ QASE_DRYTIS_INTEGRATION_ENABLED: 'false' }), false);
	assert.equal(drytisIntegrationEnabled({ QASE_DRYTIS_INTEGRATION_ENABLED: 'TRUE' }), true);
	assert.throws(() => drytisIntegrationEnabled({ QASE_DRYTIS_INTEGRATION_ENABLED: 'yes' }), /true or false/);
	assert.equal(createConfiguredDrytisIntegration({ environment: {} }), undefined);
});

test('enabled factory wires trusted services, verifier, replay store, and fixed delivery target', () => {
	const calls = {};
	const services = { runs: {}, agent: {} };
	const environment = {
		QASE_DRYTIS_INTEGRATION_ENABLED: 'true',
		QASE_PUBLIC_URL: 'https://qase.drytis.example',
		QASE_DRYTIS_RESULTS_PATH: '/integrations/qase/results'
	};
	const config = { marker: 'config' };
	const nonceStore = { consume() {} };
	const verifier = { verify() {} };
	const deliveryClient = { deliver() {} };
	const api = { mount() {} };
	const result = createConfiguredDrytisIntegration({
		environment, services, tenantContext: TENANT, runStoreMode: 'local',
		createConfig(received) { calls.environment = received; return config; },
		createMemoryNonceStore() { return nonceStore; },
		createVerifier(received) { calls.verifier = received; return verifier; },
		createDeliveryClient(received) { calls.delivery = received; return deliveryClient; },
		createApi(received) { calls.api = received; return api; }
	});
	assert.equal(result.api, api);
	assert.deepEqual(calls.verifier, { config, nonceStore });
	assert.deepEqual(calls.delivery, { config });
	assert.equal(calls.api.services, services);
	assert.equal(calls.api.tenantContext, TENANT);
	assert.equal(calls.api.publicOrigin, 'https://qase.drytis.example');
	assert.equal(calls.api.deliveryTarget, '/integrations/qase/results');
});

test('production refuses process-local replay protection and uses the PostgreSQL adapter', () => {
	const environment = { NODE_ENV: 'production', QASE_DRYTIS_INTEGRATION_ENABLED: 'true' };
	assert.throws(() => createConfiguredDrytisIntegration({
		environment, services: {}, tenantContext: TENANT, runStoreMode: 'local',
		createConfig: () => ({})
	}), /requires the PostgreSQL run store/);

	const pool = {};
	const nonceStore = { consume() {} };
	let received;
	const result = createConfiguredDrytisIntegration({
		environment, services: {}, tenantContext: TENANT, runStoreMode: 'postgres', pool,
		createConfig: () => ({ marker: true }),
		createPostgresNonceStore(value) { received = value; return nonceStore; },
		createVerifier: () => ({ verify() {} }),
		createApi: () => ({ mount() {} })
	});
	assert.deepEqual(received, { pool, tenantContext: TENANT });
	assert.equal(result.nonceStore, nonceStore);
});
