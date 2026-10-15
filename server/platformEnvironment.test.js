import test from 'node:test';
import assert from 'node:assert/strict';
import { platformEnvironment } from './platformEnvironment.js';

test('legacy platform model settings map to hosted runtime variables only', () => {
	assert.deepEqual(platformEnvironment({ CUSTOM_API_KEY: 'test-key', CUSTOM_BASE_URL: 'https://gateway.invalid/v1', CUSTOM_MODEL: 'model-a', DATABASE_URL: 'unused', PORT: '3000' }), {
		QASE_API_KEY: 'test-key', QASE_BASE_URL: 'https://gateway.invalid/v1', QASE_MODEL: 'model-a', QASE_PROVIDER: 'custom'
	});
});
test('explicit runtime environment and canonical file settings take precedence', () => {
	assert.deepEqual(platformEnvironment({ QASE_API_KEY: 'canonical', CUSTOM_API_KEY: 'legacy', QASE_MODEL: 'model-b' }, { QASE_API_KEY: 'runtime', QASE_PROVIDER: 'openai' }), { QASE_MODEL: 'model-b' });
});
test('missing settings do not manufacture a provider or model', () => {
	assert.deepEqual(platformEnvironment({}), {});
});
