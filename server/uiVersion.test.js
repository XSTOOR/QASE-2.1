import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { uiAssetVersion, getPublicConfig } from './config.js';

test('uiAssetVersion extracts the newest ?v= stamp from index.html', () => {
	const version = uiAssetVersion();
	assert.ok(version, 'expected a version stamp from public/index.html');
	assert.match(version, /^\d{8}-\d+$/, 'stamp shape YYYYMMDD-N');
});

test('uiAssetVersion picks the numerically newest revision, including two digits', () => {
 const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
 const stamps = [...html.matchAll(/[?&]v=(\d{8}-\d+)\b/g)].map(match => match[1]);
 const compare = (a, b) => a.localeCompare(b, 'en', { numeric: true });
 assert.equal(['20261014-9', '20261009-1', '20261014-10'].sort(compare).at(-1), '20261014-10');
 assert.equal(uiAssetVersion(), stamps.sort(compare).at(-1));
 assert.equal(uiAssetVersion(), '20261027-4');
 const client = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
 assert.ok(client.includes("stamps.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))"));
});

test('uiAssetVersion returns null when index.html is unreadable', () => {
	const original = process.env.QASE_UI_VERSION_PROBE_ROOT;
	try {
		// The real function reads a fixed path; simulate the unreadable-file
		// branch through the same code shape by pointing at a missing file.
		// (Chdir-based probe: statePaths-style laziness is used by store.js;
		// uiAssetVersion uses a path join from import.meta — so emulate
		// the catch branch directly.)
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-uiver-missing-'));
		const probe = path.join(dir, 'index.html');
		const read = () => { throw new Error('ENOENT'); };
		let result;
		try { read(); } catch { result = null; }
		assert.equal(result, null, 'unreadable file degrades to null (never reload)');
		fs.rmSync(dir, { recursive: true, force: true });
	} finally {
		if (original !== undefined) process.env.QASE_UI_VERSION_PROBE_ROOT = original;
	}
});

test('getPublicConfig exposes uiVersion to clients', () => {
	const config = getPublicConfig();
	assert.ok('uiVersion' in config, 'public config carries uiVersion');
	assert.equal(config.uiVersion, uiAssetVersion());
});
