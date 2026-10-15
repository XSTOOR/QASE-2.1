#!/usr/bin/env node
/**
 * Regenerate / verify the Apple compatibility environment matrix.
 *
 * Usage:
 *   node scripts/generate-environments.mjs           # seed via the configured store
 *   node scripts/generate-environments.mjs --print   # print catalog summary only (no store)
 *
 * With QASE_RUN_STORE=postgres (default when DATABASE_URL/QASE_DATABASE_* vars are
 * set) this upserts the matrix into the environments table. With the local store
 * it regenerates .qase/environments.json. Both paths are idempotent and never
 * reset operator deprecations.
 */
import { createConfiguredApplicationServices } from '../server/serviceFactory.js';
import {
	generateEnvironments,
	ENVIRONMENT_CATALOG_VERSION,
	availabilityReport
} from '../server/environmentCatalog.js';

if (process.argv.includes('--print')) {
	const environments = generateEnvironments();
	const byPlatform = {};
	for (const env of environments) {
		byPlatform[env.platform] = (byPlatform[env.platform] ?? 0) + 1;
	}
	console.log(`catalog ${ENVIRONMENT_CATALOG_VERSION}: ${environments.length} environments`);
	console.log(byPlatform);
	console.log(JSON.stringify(availabilityReport(), null, 2));
	process.exit(0);
}

const { mode, services, pool } = await createConfiguredApplicationServices();
const result = await services.environments.seed();
const count = (await services.environments.list({})).length;
console.log(`store=${mode} catalog=${result.catalogVersion} seeded=${result.inserted} total=${count}`);
if (mode === 'postgres' && pool) {
	await pool.end?.();
}
