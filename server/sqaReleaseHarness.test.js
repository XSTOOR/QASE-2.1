import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSqaAcceptanceResult, assertSqaTestBrowser, isolatedSqaEnvironment } from '../scripts/sqa-test-runtime.mjs';

test('release children keep OS discovery without inheriting credentials or application overrides', () => {
	const environment = isolatedSqaEnvironment({ Path: 'browser-bin', SYSTEMROOT: 'system', PLAYWRIGHT_BROWSERS_PATH: 'browser-cache', QASE_API_KEY: 'private', CUSTOM_API_KEY: 'private', OPENAI_API_KEY: 'private', QASE_BASE_URL: 'https://gateway.test', DATABASE_URL: 'private', NODE_OPTIONS: '--require injected.js', QASE_AUTH_REQUIRED: 'false', PORT: '5173', QASE_RUN_STORE: 'postgres', QASE_TELEGRAM_ENABLED: 'true' });
	assert.equal(environment.Path, 'browser-bin'); assert.equal(environment.PLAYWRIGHT_BROWSERS_PATH, 'browser-cache');
	for (const key of ['QASE_API_KEY', 'CUSTOM_API_KEY', 'OPENAI_API_KEY', 'QASE_BASE_URL', 'DATABASE_URL', 'NODE_OPTIONS', 'QASE_AUTH_REQUIRED', 'PORT']) assert.equal(environment[key], undefined);
	assert.equal(environment.QASE_RUN_STORE, 'local'); assert.equal(environment.QASE_TELEGRAM_ENABLED, 'false');
});

test('release matrix refuses unknown engines instead of silently falling back', () => {
	assert.equal(assertSqaTestBrowser('webkit'), 'webkit');
	assert.throws(() => assertSqaTestBrowser('safari'), /Unknown browser/);
});

test('release acceptance rejects incomplete, mismatched-browser and model-active results', () => {
	const startup = { browser: 'firefox', browserVersion: 'test', modelCalls: 0, isolated: true, startup: 'passed', negativeControl: 'passed', desktop: 'passed', mobile: 'passed' };
	assert.doesNotThrow(() => assertSqaAcceptanceResult(startup, 'firefox', 'startup'));
	for (const update of [{ browser: 'chromium' }, { modelCalls: 1 }, { isolated: false }, { negativeControl: undefined }, { browserVersion: undefined }]) {
		assert.throws(() => assertSqaAcceptanceResult({ ...startup, ...update }, 'firefox', 'startup'));
	}
	const evidence = { browser: 'webkit', browserVersion: 'test', modelCalls: 0, browserJourney: 'passed', restartPersistence: 'passed', historicalMarkdown: 'passed', historicalPdf: 'passed', versions: 2, oldVersionPreserved: true, injectionPrevented: true, mobileOverflow: false, javascriptErrors: [], evidenceStates: ['verified', 'unavailable', 'mismatch', 'external_unverified'] };
	assert.doesNotThrow(() => assertSqaAcceptanceResult(evidence, 'webkit', 'evidence'));
	for (const update of [{ restartPersistence: undefined }, { javascriptErrors: ['Unhandled error'] }, { evidenceStates: ['verified'] }, { oldVersionPreserved: false }, { mobileOverflow: true }]) {
		assert.throws(() => assertSqaAcceptanceResult({ ...evidence, ...update }, 'webkit', 'evidence'));
	}
});

test('launcher acceptance requires restored-device readiness and one explicit launch without model activity', () => {
	const result = { browser: 'chromium', browserVersion: 'test', modelCalls: 0, launcher: 'passed', delayedDeviceRestore: 'passed', explicitStart: 'passed', desktop: 'passed', mobile: 'passed', launchDispatches: 1, javascriptErrors: [] };
	assert.doesNotThrow(() => assertSqaAcceptanceResult(result, 'chromium', 'launch'));
	for (const update of [{ delayedDeviceRestore: undefined }, { explicitStart: undefined }, { mobile: undefined }, { launchDispatches: 0 }, { launchDispatches: 2 }, { modelCalls: 1 }, { javascriptErrors: ['failure'] }]) {
		assert.throws(() => assertSqaAcceptanceResult({ ...result, ...update }, 'chromium', 'launch'));
	}
});
