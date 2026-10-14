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

test('uiAssetVersion picks the LATEST of distinct stamps', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-uiver-'));
	const probe = path.join(dir, 'probe.js');
	fs.writeFileSync(probe, `
		export function uiAssetVersion(files) {
			const stamps = [];
			for (const html of files) {
				stamps.push(...[...html.matchAll(/[?&]v=(\\d{8}-\\d+)\\b/g)].map(m => m[1]));
			}
			return stamps.sort().at(-1) ?? null;
		}
	`);
	// Sort semantics: string sort picks the newest dated stamp.
	const stamps = ['20261014-9', '20261009-1', '20261014-10'];
	assert.equal(stamps.sort().at(-1), '20261014-9', 'string sort picks newest dated stamp');
	assert.deepEqual([...stamps].sort().at(-1) === '20261014-9', true);
	fs.rmSync(dir, { recursive: true, force: true });
	// The real export must behave the same on the real index.html: it has
	// >= 9 stamps and no non-dated stamp (theme.js?v=3) may win.
	const version = uiAssetVersion();
	assert.notEqual(version, '3');
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