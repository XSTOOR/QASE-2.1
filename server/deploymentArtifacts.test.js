import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifestUrl = new URL('../deploy/kubernetes/base/qase.yaml', import.meta.url);
const migrationsUrl = new URL('../deploy/kubernetes/base/migrations.yaml', import.meta.url);
const dockerfileUrl = new URL('../Dockerfile', import.meta.url);
const packageScriptUrl = new URL('../scripts/package.mjs', import.meta.url);

test('deployment baseline keeps secrets external and applies container hardening', async () => {
	const [manifest, migrations, dockerfile, packageScript] = await Promise.all([
		readFile(manifestUrl, 'utf8'), readFile(migrationsUrl, 'utf8'), readFile(dockerfileUrl, 'utf8'),
		readFile(packageScriptUrl, 'utf8')
	]);
	assert.doesNotMatch(`${manifest}\n${migrations}`, /kind:\s+Secret\b/);
	assert.doesNotMatch(manifest, /image:\s+\S+:latest\b/);
	assert.match(manifest, /readOnlyRootFilesystem:\s+true/);
	assert.match(manifest, /allowPrivilegeEscalation:\s+false/);
	assert.match(manifest, /automountServiceAccountToken:\s+false/);
	assert.match(manifest, /QASE_DATABASE_MIGRATE_ON_START:\s+"false"/);
	assert.match(manifest, /QASE_AUTH_MODE:\s+drytis/);
	assert.match(manifest, /name:\s+QASE_API_KEY[\s\S]+secretKeyRef/);
	assert.match(migrations, /qase-cell-migrator/);
	assert.match(migrations, /qase-control-migrator/);
	assert.match(dockerfile, /USER node/);
	assert.match(dockerfile, /npm ci --omit=dev/);
	assert.match(packageScript, /'deploy'/);
	assert.match(packageScript, /'Dockerfile'/);
});
