import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalSecretVault } from './secrets.js';

const RUN_ID = 'd6c033ab-3797-4c77-9ed5-1207ea3d9e68';

function fixture(t) {
	const stateDirectory = mkdtempSync(join(tmpdir(), 'qase-secrets-'));
	t.after(() => rmSync(stateDirectory, { recursive: true, force: true }));
	return stateDirectory;
}

test('local credential vault restores encrypted run secrets after a process restart', t => {
	const stateDirectory = fixture(t);
	const firstProcess = createLocalSecretVault({ stateDirectory });
	assert.deepEqual(firstProcess.store(RUN_ID, {
		qa_username: 'operator@example.test',
		qa_password: 'restart-safe-private-value'
	}), ['QA_USERNAME', 'QA_PASSWORD']);

	const storedFiles = readdirSync(join(stateDirectory, 'run-secrets'));
	assert.equal(storedFiles.length, 1);
	const persisted = readFileSync(join(stateDirectory, 'run-secrets', storedFiles[0]), 'utf8');
	assert.doesNotMatch(persisted, /operator@example\.test|restart-safe-private-value/);

	const restartedProcess = createLocalSecretVault({ stateDirectory });
	assert.deepEqual(restartedProcess.names(RUN_ID), ['QA_USERNAME', 'QA_PASSWORD']);
	assert.equal(
		restartedProcess.resolve(RUN_ID, '{{QA_USERNAME}} / {{QA_PASSWORD}}'),
		'operator@example.test / restart-safe-private-value'
	);
	assert.equal(
		restartedProcess.redact(RUN_ID, 'password=restart-safe-private-value'),
		'password=••••••••'
	);
});

test('local credential vault deletes terminal run material and fails closed on corruption', t => {
	const stateDirectory = fixture(t);
	const vault = createLocalSecretVault({ stateDirectory });
	vault.store(RUN_ID, { qa_password: 'private-value' });
	const secretFile = join(stateDirectory, 'run-secrets', readdirSync(join(stateDirectory, 'run-secrets'))[0]);

	const restartedProcess = createLocalSecretVault({ stateDirectory });
	assert.equal(restartedProcess.clear(RUN_ID), true);
	assert.deepEqual(restartedProcess.names(RUN_ID), []);
	assert.equal(readdirSync(join(stateDirectory, 'run-secrets')).length, 0);

	vault.store(RUN_ID, { qa_password: 'another-private-value' });
	writeFileSync(secretFile, '{"v":1,"data":"tampered"}', { mode: 0o600 });
	const corruptedProcess = createLocalSecretVault({ stateDirectory });
	assert.deepEqual(corruptedProcess.names(RUN_ID), []);
	assert.equal(corruptedProcess.resolve(RUN_ID, '{{QA_PASSWORD}}'), '{{QA_PASSWORD}}');
});
