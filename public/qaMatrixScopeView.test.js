import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/* Pipeline Phase 1 → #15969 UPDATE: the scope-as-view contract was retired
 * with the scoped-view UI. The device selector is now platform tabs +
 * one-click rows; the invariant that SURVIVES is: view/filter operations
 * (tabs, search, bulk headers) never mutate selection sets — only explicit
 * user toggles (browser card clicks, device row clicks) do, through
 * qaMatrixApplySelection. */
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const picker = readFileSync(new URL('./matrixPicker.js', import.meta.url), 'utf8');

function functionBody(source, name) {
	const start = source.indexOf(`function ${name}(`);
	assert.ok(start !== -1, `function ${name} exists`);
	// naive brace matcher — the function body only
	let depth = 0;
	let bodyStart = -1;
	for (let i = start; i < source.length; i += 1) {
		if (source[i] === '{') {
			if (bodyStart === -1) bodyStart = i;
			depth += 1;
		} else if (source[i] === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(bodyStart, i + 1);
		}
	}
	assert.fail(`unbalanced braces in ${name}`);
}

test('#15969: platform tab clicks are view-only — no selection mutation', () => {
	// The tab handler sets the filter + reloads the window; it must not touch
	// any selection set.
	const tabBlock = picker.slice(picker.indexOf("platform.addEventListener('change'"), picker.indexOf('const only ='));
	assert.ok(tabBlock.length > 10, 'platform tab builder exists');
	for (const forbidden of ['selection.deviceKeys', 'selection.browserFamilies', 'deselectedEnvIds', 'qaMatrixApplySelection']) {
		assert.ok(!tabBlock.includes(forbidden), `tab handler must not touch ${forbidden}`);
	}
	assert.match(tabBlock, /view\.platform = platform\.value/);
});

test('#15969: scope-view UI is fully retired', () => {
	// The removed affordances stay removed.
	assert.ok(!app.includes('function qaMatrixSetDeviceScope('), 'scope setter deleted');
	assert.ok(!app.includes('function qaMatrixScopeLabel('), 'scope label deleted');
	assert.ok(!app.includes('qa-matrix-scope-banner'), 'scope banner deleted');
	assert.ok(!app.includes('Back to all devices'), 'scope exit deleted');
	assert.ok(!app.includes("dataset.role = 'device-view'"), 'View scope button deleted');
});

test('#15969: summary still shows the GLOBAL selection count', () => {
	const body = functionBody(app, 'qaMatrixRender');
	assert.ok(body.includes('renderMatrixPicker'), 'renderer delegates to the modular picker');
	assert.match(picker, /new Set\(computeExplicitSelection\(index, selection\)\)/, 'count uses the entire catalog selection');
	assert.match(picker, /selected\.size\.toLocaleString\(\)/, 'global count is rendered');
	assert.ok(!body.includes('viewing:'), 'no scoped-view branch remains');
});

test('Phase 1 (kept): filters write ONLY qaMatrixState.filters (render-only)', () => {
	// The filter wiring function must not touch any selection set.
	const body = functionBody(app, 'qaMatrixWiring');
	for (const forbidden of ['selection.deviceKeys', 'selection.browserFamilies', 'deselectedEnvIds', 'qaMatrixApplySelection']) {
		assert.ok(!body.includes(forbidden), `filter wiring must not touch ${forbidden}`);
	}
	assert.ok(body.includes('qaMatrixState.filters'), 'filter wiring writes the filters object');
});

test('Phase 1 (kept): bulk select-all actions clear stale granular opt-outs', () => {
	const matrix = readFileSync(new URL('./qaConfigMatrix.js', import.meta.url), 'utf8');
	// selectAllDevices/selectAllBrowsers must construct fresh empty override sets.
	for (const name of ['selectAllDevices', 'selectAllBrowsers']) {
		const body = functionBody(matrix, name);
		assert.match(body, /deselectedEnvIds: new Set\(\)/, `${name} clears granular opt-outs`);
	}
});

test('matrix cells directly apply exact pair changes without routing', () => {
	assert.match(picker, /apply\(changeMatrixPairs\(index, selection, \[\[device\.key, family\.code\]\], checked\)\)/);
	assert.doesNotMatch(picker, /pageRouter|navigate\(/);
});
