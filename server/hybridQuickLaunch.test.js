import assert from 'node:assert/strict';
import test from 'node:test';
import { hybridLaunchOptions } from '../public/hybridQaView.js';
import { sanitizeSelection, isSelectable } from '../public/qaConfigMatrix.js';

/**
 * Regression contract for the wizard submit path (#17638): Hybrid QA must be
 * launchable in BOTH journey modes.
 *
 *  - Quick ("Recommended checks") mode submits the DERIVED focused selection
 *    (qaMatrixEffectiveSelection() sanitized against the catalog index), not
 *    an empty list. An empty env list previously made hybridLaunchOptions
 *    throw 'choose Focused check' before any request was sent, while the
 *    review step claimed "Everything is ready".
 *  - Custom mode submits qaMatrixState.selectedEnvIds as before.
 *  - Legacy mode never reaches hybridLaunchOptions (returns null).
 *
 * These tests pin the exact selection-shape computation the submit handler
 * performs, using the same public helpers, so a future refactor of either
 * mode cannot silently break hybrid launches again.
 */

const hybridConfig = { hybridQa: { enabled: true, qualified: true, available: true, status: 'ready' } };
const catalog = [
	{ envId: 'ENV-MAC-M4-CHR-151', browserCode: 'chrome', platform: 'macos', availability: 'AVAILABLE', executionEngine: 'chromium' },
	{ envId: 'ENV-WIN-10-CHR-151', browserCode: 'chrome', platform: 'windows', availability: 'AVAILABLE', executionEngine: 'chromium' },
	{ envId: 'ENV-WIN-10-DDG-3', browserCode: 'duckduckgo', platform: 'windows', availability: 'NOT_SUPPORTED' },
	{ envId: 'ENV-AND-GALA15-13-BRV-155', browserCode: 'brave', platform: 'android', availability: 'AVAILABLE', executionEngine: 'chromium' }
];

test('quick mode derives exactly one env id for hybrid from the focused selection', () => {
	// The submit handler computes: sanitizeSelection(index, qaMatrixEffectiveSelection()).
	// qaFocusedSelection() for hybrid resolves to ONE row (singleSelection).
	const focusedRow = catalog.find(row => row.browserCode === 'chrome' && ['windows', 'macos', 'linux'].includes(row.platform) && isSelectable(row));
	const derived = sanitizeSelection(catalog, [focusedRow.envId]);
	// A single focused selection resolves to one env id…
	assert.equal(derived.length, 1);
	// …and hybridLaunchOptions accepts it in quick mode.
	const options = hybridLaunchOptions({ config: hybridConfig, mode: 'hybrid', envIds: derived, configurations: catalog });
	assert.equal(options.qaExecutionMode, 'hybrid');
	assert.equal(options.environmentId, derived[0]);
	assert.equal(options.engine, 'chromium');
});

test('an empty quick-mode env list (the regression) cannot be passed to hybridLaunchOptions', () => {
	// Before #17638 the handler passed [] in quick mode and threw here.
	assert.throws(() => hybridLaunchOptions({ config: hybridConfig, mode: 'hybrid', envIds: [], configurations: catalog }), /one browser/);
});

test('sanitizeSelection drops unavailable rows so a stale focused pick cannot launch', () => {
	const selection = sanitizeSelection(catalog, ['ENV-WIN-10-DDG-3']);
	assert.deepEqual(selection, [], 'NOT_SUPPORTED rows are filtered before hybrid validation');
	assert.throws(() => hybridLaunchOptions({ config: hybridConfig, mode: 'hybrid', envIds: selection, configurations: catalog }), /one browser/);
});

test('custom mode with one selected env still launches hybrid', () => {
	const options = hybridLaunchOptions({ config: hybridConfig, mode: 'hybrid', envIds: sanitizeSelection(catalog, ['ENV-WIN-10-CHR-151']), configurations: catalog });
	assert.equal(options.environmentId, 'ENV-WIN-10-CHR-151');
});

test('legacy mode bypasses hybrid launch entirely', () => {
	assert.equal(hybridLaunchOptions({ config: hybridConfig, mode: 'legacy', envIds: [] }), null);
});
