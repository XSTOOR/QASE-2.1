import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightSqaRuntime } from './sqaRuntime.js';

test('SQA preflight detects the selected Safari engine before creating a run', async () => {
  let checked;
  await assert.rejects(preflightSqaRuntime({ environment: { browserCode: 'safari' }, engine: 'chromium' }, {
    executionResolver: async () => ({ mode: 'emulated', executionEngine: 'webkit' }),
    engineResolver: async id => { checked = id; return { available: false, reason: 'Run: npx playwright install webkit' }; }
  }), error => error.status === 422 && /playwright install webkit/.test(error.message));
  assert.equal(checked, 'webkit');
});
test('SQA uses an installed selected engine without silently falling back', async () => {
  assert.equal(await preflightSqaRuntime({ environment: { browserCode: 'safari' } }, {
    executionResolver: async () => ({ mode: 'emulated', executionEngine: 'webkit' }),
    engineResolver: async id => ({ available: id === 'webkit' })
  }), 'webkit');
});
test('remote SQA execution does not require a local WebKit bundle', async () => {
  assert.equal(await preflightSqaRuntime({ environment: { browserCode: 'safari' } }, {
    executionResolver: async () => ({ mode: 'environment' }),
    engineResolver: async () => { throw new Error('must not probe a local browser'); }
  }), 'webkit');
});
test('blocked remote device remains blocked with an actionable selection error', async () => {
  await assert.rejects(preflightSqaRuntime({}, {
    executionResolver: async () => ({ mode: 'blocked', reason: 'No device-farm runtime configured.' })
  }), error => error.status === 422 && /No device-farm runtime/.test(error.message));
});
test('an available branded binary does not depend on the bundled Chromium installation', async () => {
  assert.equal(await preflightSqaRuntime({}, {
    executionResolver: async () => ({ mode: 'emulated', executionEngine: 'chromium', brandedExecutablePath: 'chrome.exe' }),
    engineResolver: async () => { throw new Error('must not require a separate bundle'); }
  }), 'chromium');
});
