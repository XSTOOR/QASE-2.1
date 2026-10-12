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
	const tabBlock = app.slice(app.indexOf('const makeTab'), app.indexOf('deviceHeader.append(tabGroup);'));
	assert.ok(tabBlock.length > 10, 'platform tab builder exists');
	for (const forbidden of ['selection.deviceKeys', 'selection.browserFamilies', 'deselectedEnvIds', 'qaMatrixApplySelection']) {
		assert.ok(!tabBlock.includes(forbidden), `tab handler must not touch ${forbidden}`);
	}
	assert.match(tabBlock, /qaMatrixState\.filters\.platform = id === 'all' \? '' : id/);
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
	assert.ok(body.includes('summary.total'), 'summary renders the global configuration count');
	assert.ok(body.includes('summary.availableTotal'), 'summary renders the available total');
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

test('#15969: device row click IS the selection path (single action, no routing)', () => {
	const index = app.indexOf("row.dataset.role = 'device-row'");
	assert.ok(index !== -1);
	const handler = app.slice(index, app.indexOf('rowList.append(row);'));
	assert.match(handler, /toggleDevice\(next, device\.key, !selection\.deviceKeys\.has\(device\.key\)\)/);
	assert.match(handler, /qaMatrixApplySelection\(next\)/);
});
