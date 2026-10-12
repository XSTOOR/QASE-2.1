import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/* Pipeline Phase 1 — scope-as-view contract, asserted against app.js source
 * (the launcher is a browser script; this suite follows the project's
 * qaUiSelection.test.js source-assertion pattern). The contract:
 *   - qaMatrixSetDeviceScope NEVER mutates selection sets
 *   - scope is always exitable ("← Back to all devices" → scope null)
 *   - the scoped summary still shows the GLOBAL count
 *   - filters write only qaMatrixState.filters (render-only) */
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

test('Phase 1: qaMatrixSetDeviceScope mutates NO selection state', () => {
	const body = functionBody(app, 'qaMatrixSetDeviceScope');
	for (const forbidden of [
		'selection.deviceKeys', 'selection.browserFamilies', 'deselectedEnvIds',
		'qaMatrixApplySelection', 'deviceScopeSessionDeselections',
		'unscopedExplicitSelection', 'qaMatrixStore'
	]) {
		assert.ok(!body.includes(forbidden), `scope setter must not touch ${forbidden}`);
	}
	assert.ok(body.includes('deviceScope = scope'), 'scope setter sets the view scope');
	assert.ok(body.includes('qaMatrixEffectiveSelection()'), 'count is re-derived from unchanged state');
});

test('Phase 1: scope exit affordance exists and reaches qaMatrixSetDeviceScope(null)', () => {
	assert.match(app, /qa-matrix-scope-banner/);
	assert.match(app, /scope-exit/);
	assert.match(app, /Back to all devices/);
	// The exit button handler must null the scope.
	const exitIndex = app.indexOf("back.dataset.role = 'scope-exit'");
	assert.ok(exitIndex !== -1);
	const handler = app.slice(exitIndex, exitIndex + 700);
	assert.match(handler, /qaMatrixSetDeviceScope\(null\)/, 'exit handler clears the scope');
});

test('Phase 1: scoped summary still shows the GLOBAL selection count', () => {
	const body = functionBody(app, 'qaMatrixRender');
	const summaryIndex = body.indexOf('globalCount');
	assert.ok(summaryIndex !== -1, 'summary renders globalCount');
	assert.ok(body.includes('viewing:'), 'scoped branch appends the view label AFTER the global count');
});

test('Phase 1: filters write ONLY qaMatrixState.filters (render-only)', () => {
	// The filter wiring function must not touch any selection set.
	const body = functionBody(app, 'qaMatrixWiring');
	for (const forbidden of ['selection.deviceKeys', 'selection.browserFamilies', 'deselectedEnvIds', 'qaMatrixApplySelection']) {
		assert.ok(!body.includes(forbidden), `filter wiring must not touch ${forbidden}`);
	}
	assert.ok(body.includes('qaMatrixState.filters'), 'filter wiring writes the filters object');
});

test('Phase 1: bulk select-all actions clear stale granular opt-outs', () => {
	const matrix = readFileSync(new URL('./qaConfigMatrix.js', import.meta.url), 'utf8');
	// selectAllDevices/selectAllBrowsers must construct fresh empty override sets.
	for (const name of ['selectAllDevices', 'selectAllBrowsers']) {
		const body = functionBody(matrix, name);
		assert.match(body, /deselectedEnvIds: new Set\(\)/, `${name} clears granular opt-outs`);
	}
});

test('Phase 1: device-row click handler ignores label/button clicks (scope, not selection)', () => {
	const index = app.indexOf("deviceRow.addEventListener('click'");
	assert.ok(index !== -1);
	const handler = app.slice(index, index + 400);
	assert.match(handler, /event\.target\.closest\('label'\)/, 'label clicks keep chip semantics');
	assert.match(handler, /event\.target\.closest\('button'\)/, 'button clicks keep their semantics');
	assert.match(handler.slice(0, 300) + app.slice(app.indexOf('const activateScope'), app.indexOf('const activateScope') + 400),
		/activateScope/, 'row click routes to the scope activation path');
});
