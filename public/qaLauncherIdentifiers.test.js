import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/* #15969 (reviewer FAIL follow-up): source-assertion suites read app.js as
 * text — they cannot see ReferenceError-class regressions (functions deleted
 * while call sites remain, e.g. the blockedReason / loadQaMatrixCatalog
 * incidents). This suite statically resolves every NON-DOM identifier used
 * inside the launcher's QA-matrix region and asserts each is defined
 * somewhere in the file. It is a cheap, PID-safe substitute for a full DOM
 * module import (app.js touches window/document at module scope). */

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

/** Extract `name` from `function name(`, `const name =`, `let name =`,
 *  `class name`, or an import binding line. */
function definedNames(source) {
	const names = new Set();
	const patterns = [
		/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
		/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
		/\bclass\s+([A-Za-z_$][\w$]*)/g,
		/\{([^}]+)\}\s*from\s*['"]/g
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			const captured = match[1];
			for (const part of captured.split(',')) {
				const name = part.trim().split(/\s+as\s+/).pop()?.replace(/^.*:/, '').trim();
				if (/^[A-Za-z_$][\w$]*$/.test(name ?? '')) names.add(name);
			}
		}
	}
	return names;
}

test('every QA-matrix launcher identifier resolves to a definition in app.js', () => {
	// The launcher region: from the qaMatrixState object to the end of the
	// openQaStart/closeQaStart area (qaMatrix call sites live here).
	const start = app.indexOf('const qaMatrixState = {');
	const end = app.indexOf('function closeQaStart');
	assert.ok(start !== -1 && end > start, 'launcher region found');
	const region = app.slice(start, end);
	const defined = definedNames(app);
	// Identifiers referenced in the region that must exist module-wide.
	// (Method calls on objects and locals declared inside the region are
	// covered by including region-local definitions too.)
	const localDefined = definedNames(region);
	const required = [
		'loadQaMatrixCatalog', 'renderMatrixPicker',
		'qaMatrixApplySelection', 'qaMatrixSetState', 'qaSelectionStore',
		'qaMatrixEffectiveSelection', 'qaMatrixRender', 'qaMatrixWiring',
		'createSelectionState', 'computeExplicitSelection',
		'fetchQaConfigurations', 'fetchConfigurationIndex',
		'isSelectable', 'deviceKeyOf', 'brandIcon', 'syncQaSubmitState'
	];
	const missing = required.filter(name => !defined.has(name) && !localDefined.has(name));
	assert.deepEqual(missing, [], `missing definitions: ${missing.join(', ')}`);
});

test('identifier-use scan: no obvious use-before-definition of the documented casualties', () => {
	// The two shipped incidents must stay fixed: every call site of the
	// previously-deleted functions must have a definition present.
	for (const name of ['loadQaMatrixCatalog', 'qaMatrixLoadWindow', 'qaMatrixFiltered', 'qaMatrixApplySelection', 'qaMatrixSetState', 'qaSelectionStore', 'renderTestOn']) {
		const uses = (app.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
		const defs = (app.match(new RegExp(`(function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=)`, 'g')) ?? []).length;
		assert.ok(uses === 0 || defs >= 1, `${name} is used but never defined`);
	}
});
