import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createLocalEnvironmentBackend,
	EnvironmentValidationError
} from './environmentService.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'qase-runtime-'));

test('normalizeEnvironmentInput persists permission + orientation scenarios and requested level', async () => {
	const dir = tempDir();
	const backend = createLocalEnvironmentBackend({ stateDir: dir });
	const created = await backend.create(null, {
		platform: 'ios', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'safari',
		permissionScenario: { camera: 'deny', microphone: 'allow' },
		orientationScenario: 'landscape',
		executionLevelRequested: 'REAL_DEVICE'
	});
	assert.deepEqual(created.permissionScenario, { camera: 'deny', microphone: 'allow' });
	assert.equal(created.orientationScenario, 'landscape');
	assert.equal(created.executionLevelRequested, 'REAL_DEVICE');
	rmSync(dir, { recursive: true, force: true });
});

test('invalid scenarios are rejected with EnvironmentValidationError, not coerced', async () => {
	const dir = tempDir();
	const backend = createLocalEnvironmentBackend({ stateDir: dir });
	await assert.rejects(
		() => backend.create(null, {
			platform: 'ios', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'safari',
			permissionScenario: { camera: 'maybe' }
		}),
		(error) => error instanceof EnvironmentValidationError
	);
	await assert.rejects(
		() => backend.create(null, {
			platform: 'macos', device: 'macOS Sonoma', osVersion: 'Sonoma', browser: 'safari',
			orientationScenario: 'rotate-during-test'
		}),
		(error) => error instanceof EnvironmentValidationError
	);
	rmSync(dir, { recursive: true, force: true });
});

test('update accepts validated scenario patches; bad patches rejected', async () => {
	const dir = tempDir();
	const backend = createLocalEnvironmentBackend({ stateDir: dir });
	const created = await backend.create(null, {
		platform: 'android', device: 'Pixel 9', osVersion: '15', browser: 'chrome', browserVersion: '151'
	});
	assert.equal(created.permissionScenario, null, 'no scenario by default');
	const updated = await backend.update(null, created.envId, {
		permissionScenario: { camera: 'deny' },
		orientationScenario: 'rotate-during-test'
	});
	assert.deepEqual(updated.permissionScenario, { camera: 'deny' });
	assert.equal(updated.orientationScenario, 'rotate-during-test');
	await assert.rejects(
		() => backend.update(null, created.envId, { permissionScenario: { telepathy: 'allow' } }),
		(error) => error instanceof EnvironmentValidationError
	);
	rmSync(dir, { recursive: true, force: true });
});

test('seeded environments (no scenario input) keep working unchanged', async () => {
	const dir = tempDir();
	const backend = createLocalEnvironmentBackend({ stateDir: dir });
	await backend.seed();
	const legacy = await backend.get(null, 'ENV-IOS-IP16PRO-18.3-SAF-18.3');
	assert.ok(legacy, 'seeded env exists');
	assert.equal(legacy.permissionScenario ?? null, null);
	assert.equal(legacy.orientationScenario ?? null, null);
	rmSync(dir, { recursive: true, force: true });
});
