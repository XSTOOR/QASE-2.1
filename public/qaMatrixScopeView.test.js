import assert from 'node:assert/strict';
import test from 'node:test';
import { pickerHarness } from './matrixPickerHarness.js';
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

test('device filters are view-only and never apply a selection', () => {
	const h = pickerHarness(); h.filter('platform', 'android'); h.filter('category', 'mobile');
	assert.equal(h.applications(), 0); assert.deepEqual(h.ids(), ['desktop']);
});

test('#15969: scope-view UI is fully retired', () => {
	// The removed affordances stay removed.
	assert.ok(!app.includes('function qaMatrixSetDeviceScope('), 'scope setter deleted');
	assert.ok(!app.includes('function qaMatrixScopeLabel('), 'scope label deleted');
	assert.ok(!app.includes('qa-matrix-scope-banner'), 'scope banner deleted');
	assert.ok(!app.includes('Back to all devices'), 'scope exit deleted');
	assert.ok(!app.includes("dataset.role = 'device-view'"), 'View scope button deleted');
});

test('selected pair remains in the summary outside the current device filter', () => {
	const h = pickerHarness(); h.search('pixel');
	assert.match(h.text(h.hosts.summary), /Desktop/); assert.deepEqual(h.ids(), ['desktop']);
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

test('one device button applies one exact environment without routing', () => {
	const h = pickerHarness(); h.click('device-Google|android|Pixel 9');
	assert.deepEqual(h.ids(), ['phone']); assert.doesNotMatch(picker, /pageRouter|navigate\(/);
});
