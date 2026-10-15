import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArtifactStore, executionMetadataFor } from './artifactStore.js';

function tempRoot() {
	// A unique directory per store instance keeps tests isolated.
	return fs.mkdtempSync(path.join(os.tmpdir(), 'qase-artifacts-'));
}

test('executionMetadataFor prefers recorded runtime facts over requested level', () => {
	const meta = executionMetadataFor(
		{ executionLevel: 'SIMULATED', runtimeFacts: { executionLevel: 'REAL_DEVICE', provider: 'lab-x' } },
		{ level: 'SIMULATED', provider: 'local' }
	);
	assert.equal(meta.executionLevel, 'REAL_DEVICE');
	assert.equal(meta.executionProvider, 'lab-x');
});

test('executionMetadataFor falls back to session level, then bridge, then null', () => {
	assert.equal(executionMetadataFor({ executionLevel: 'VIRTUAL_DEVICE' }).executionLevel, 'VIRTUAL_DEVICE');
	assert.equal(executionMetadataFor({}, { level: 'SIMULATED', provider: 'local-simulation' })
		.executionLevel, 'SIMULATED');
	assert.equal(executionMetadataFor({}).executionLevel, null);
});

test('save stamps full environment + execution metadata and survives listing', () => {
	const store = createArtifactStore({ root: tempRoot });
	const png = Buffer.from('89504e470d0a1a0a', 'hex');
	const meta = store.save(
		{
			id: 'run-1',
			environmentSnapshot: {
				envId: 'ENV-AND-GALS24-14-CHR-138', device: 'Samsung Galaxy S24', os: 'android',
				osVersion: '14', browser: 'Chrome', browserVersion: '138'
			},
			executionLevel: 'SIMULATED',
			executionProviderActual: 'local-simulation'
		},
		{ type: 'screenshot', fileName: 'shot.png', bytes: png }
	);
	assert.match(meta.artifactId, /^ART-[0-9A-F]{8}$/);
	assert.equal(meta.executionLevel, 'SIMULATED');
	assert.equal(meta.executionProvider, 'local-simulation');
	assert.equal(meta.device, 'Samsung Galaxy S24');
	assert.equal(meta.osVersion, '14');
	assert.equal(meta.browser, 'Chrome');
	assert.equal(meta.contentType, 'image/png');
	assert.equal(meta.bytes, png.length);

	const listed = store.list('run-1');
	assert.ok(listed.some(entry => entry.artifactId === meta.artifactId));
});

test('get returns bytes + metadata; unknown ids return null', () => {
	const store = createArtifactStore({ root: tempRoot });
	store.save({ id: 'run-2' }, { fileName: 'a.png', bytes: Buffer.from('hi') });
	const found = store.get('run-2', store.list('run-2')[0].artifactId);
	assert.ok(found);
	assert.equal(found.bytes.toString(), 'hi');
	assert.equal(found.meta.executionLevel, null); // honestly absent, not faked
	assert.equal(store.get('run-2', 'ART-NOPE'), null);
	assert.equal(store.get('../etc', 'x'), null);
});

test('removeAll prunes artifacts without orphans', () => {
	const store = createArtifactStore({ root: tempRoot });
	store.save({ id: 'run-3' }, { fileName: 'a.png', bytes: Buffer.from('x') });
	assert.equal(store.list('run-3').length, 1);
	assert.equal(store.removeAll('run-3'), true);
	assert.equal(store.list('run-3').length, 0);
	assert.equal(store.removeAll('run-3'), false);
});

test('repeated filenames preserve immutable bytes for every artifact', () => {
	const store = createArtifactStore({ root: tempRoot() });
	const first = store.save({ id: 'repeat-run' }, { fileName: 'final.jpg', bytes: Buffer.from('first') });
	const second = store.save({ id: 'repeat-run' }, { fileName: 'final.jpg', bytes: Buffer.from('second') });
	assert.notEqual(first.fileName, second.fileName);
	assert.equal(store.get('repeat-run', first.artifactId).bytes.toString(), 'first');
	assert.equal(store.get('repeat-run', second.artifactId).bytes.toString(), 'second');
});

test('JSON evidence payloads never appear as metadata entries', () => {
	const store = createArtifactStore({ root: tempRoot() });
	const meta = store.save({ id: 'json-run' }, { fileName: 'evidence.json', bytes: Buffer.from(JSON.stringify({ type: 'evidence-bundle' })) });
	assert.deepEqual(store.list('json-run').map(item => item.artifactId), [meta.artifactId]);
});

test('independent worker and API stores retrieve evidence from the shared root', () => {
	const root = tempRoot();
	const worker = createArtifactStore({ root });
	const meta = worker.save({ id: 'shared-run' }, { fileName: 'frame.jpg', bytes: Buffer.from('evidence') });
	const api = createArtifactStore({ root });
	assert.equal(api.list('shared-run').length, 1);
	assert.equal(api.get('shared-run', meta.artifactId).bytes.toString(), 'evidence');
});
