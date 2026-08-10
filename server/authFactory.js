import { createAuthentication } from './auth.js';
import { createDrytisAuthentication } from './drytisAuth.js';
import { createPostgresIdentityRepository } from './postgres/identityRepository.js';

export const AUTH_MODES = Object.freeze(['local', 'drytis']);

export function configuredAuthenticationMode(environment = process.env) {
	const mode = String(environment.QASE_AUTH_MODE ?? 'local').trim().toLowerCase();
	if (!AUTH_MODES.includes(mode)) throw new TypeError(`QASE_AUTH_MODE must be one of: ${AUTH_MODES.join(', ')}.`);
	return mode;
}

export function createConfiguredAuthentication(options = {}) {
	const environment = options.environment ?? process.env;
	const mode = configuredAuthenticationMode(environment);
	if (mode === 'local') return { mode, authentication: (options.createLocal ?? createAuthentication)() };
	if (options.runStoreMode !== 'postgres' || !options.pool) {
		throw new Error('Drytis authentication requires QASE_RUN_STORE=postgres.');
	}
	const repository = (options.createRepository ?? createPostgresIdentityRepository)({ pool: options.pool });
	const authentication = (options.createDrytis ?? createDrytisAuthentication)({
		repository,
		tenantContext: options.tenantContext,
		environment
	});
	return { mode, authentication };
}
