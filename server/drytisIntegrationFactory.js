import { createDrytisIntegrationApi } from './drytisIntegrationApi.js';
import { createDrytisIntegrationConfig } from './drytisIntegrationConfig.js';
import {
	createDrytisDeliveryClient,
	createDrytisRequestVerifier,
	createMemoryDrytisNonceStore
} from './drytisTransport.js';
import { createPostgresDrytisNonceStore } from './postgres/drytisNonceStore.js';

export function drytisIntegrationEnabled(environment = process.env) {
	const value = String(environment.QASE_DRYTIS_INTEGRATION_ENABLED ?? '').trim().toLowerCase();
	if (!value || value === 'false') return false;
	if (value === 'true') return true;
	throw new TypeError('QASE_DRYTIS_INTEGRATION_ENABLED must be true or false.');
}

/**
 * Build the disabled-by-default Drytis service data plane.
 *
 * Production replay protection is deliberately PostgreSQL-backed. A process-
 * local nonce map is allowed only for a single-node development cell.
 */
export function createConfiguredDrytisIntegration(options = {}) {
	const environment = options.environment ?? process.env;
	if (!drytisIntegrationEnabled(environment)) return undefined;
	const services = options.services;
	const tenantContext = options.tenantContext;
	if (!services || !tenantContext) {
		throw new TypeError('Drytis integration requires application services and trusted tenant context.');
	}
	const production = environment.NODE_ENV === 'production';
	if (production && (!options.pool || options.runStoreMode !== 'postgres')) {
		throw new Error('Production Drytis integration requires the PostgreSQL run store and shared replay protection.');
	}

	const config = (options.createConfig ?? createDrytisIntegrationConfig)(environment);
	const nonceStore = options.nonceStore ?? (options.pool
		? (options.createPostgresNonceStore ?? createPostgresDrytisNonceStore)({
			pool: options.pool,
			tenantContext
		})
		: (options.createMemoryNonceStore ?? createMemoryDrytisNonceStore)());
	const verifier = (options.createVerifier ?? createDrytisRequestVerifier)({ config, nonceStore });
	const deliveryTarget = String(environment.QASE_DRYTIS_RESULTS_PATH ?? '').trim() || undefined;
	const deliveryClient = deliveryTarget
		? (options.createDeliveryClient ?? createDrytisDeliveryClient)({ config })
		: undefined;
	const api = (options.createApi ?? createDrytisIntegrationApi)({
		services,
		tenantContext,
		verifier,
		publicOrigin: String(environment.QASE_PUBLIC_URL ?? '').trim() || undefined,
		logger: options.logger,
		deliveryClient,
		deliveryTarget
	});
	return Object.freeze({ api, config, nonceStore, deliveryClient, deliveryTarget });
}
