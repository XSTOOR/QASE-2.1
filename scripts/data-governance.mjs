import 'dotenv/config';
import { runGovernanceCommand } from '../server/governanceCommand.js';
import { createPostgresPool } from '../server/postgres/pool.js';
import { createPostgresRetentionRepository } from '../server/postgres/retentionRepository.js';
import { createPostgresRunRepository } from '../server/postgres/runRepository.js';
import { createTenantContext } from '../server/tenancy.js';

const tenantContext = createTenantContext(process.env);
const pool = createPostgresPool({ environment: process.env });
const repository = createPostgresRetentionRepository({ pool, tenantContext });
const cleanupRepository = createPostgresRunRepository({ pool, tenantContext });

try {
	const result = await runGovernanceCommand({
		repository,
		cleanupRepository,
		environment: process.env,
		args: process.argv.slice(2)
	});
	console.log(JSON.stringify({
		organizationId: tenantContext.organizationId,
		projectId: tenantContext.projectId,
		result
	}, null, 2));
} finally {
	await pool.end();
}
