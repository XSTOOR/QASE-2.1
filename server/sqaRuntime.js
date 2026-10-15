import { resolveExecution, engineForBrowser } from './browserstackProvider.js';
import { resolveEngine } from './browserEngines.js';
import { PublicInputError } from './publicErrors.js';

/** Reject an unusable selection before creating a run or spending model tokens.
 * Remote devices do not depend on local browser installations. Never switch a
 * requested Safari/Firefox run to Chromium behind the user's back. */
export async function preflightSqaRuntime({ environment, engine = 'chromium' }, {
  executionResolver = resolveExecution, engineResolver = resolveEngine
} = {}) {
  const execution = await executionResolver(environment);
  if (execution.mode === 'blocked') {
    throw new PublicInputError(`SQA cannot start: ${execution.reason} Choose an available test environment.`, 422);
  }
  const selectedEngine = execution.executionEngine ?? engineForBrowser(environment?.browserCode) ?? engine;
  if (execution.mode !== 'environment' && !execution.brandedExecutablePath) {
    const runtime = await engineResolver(selectedEngine);
    if (!runtime.available) {
      throw new PublicInputError(`SQA cannot start on the selected ${selectedEngine} engine: ${runtime.reason} Install this browser on the QASE server or select another available browser.`, 422);
    }
  }
  return selectedEngine;
}
