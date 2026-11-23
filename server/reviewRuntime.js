import { resolveExecution } from './browserstackProvider.js';
import { resolveEngine } from './browserEngines.js';
import { PublicInputError } from './publicErrors.js';
import { resolveRunRuntime, RuntimeUnavailableError } from './runRuntime.js';

/** Reject an unusable selection before creating a run or spending model tokens.
 * Remote devices do not depend on local browser installations. Never switch a
 * requested Safari/Firefox run to Chromium behind the user's back. The same
 * check runs for QA, SQA and Founder (server/runRuntime.js). */
async function preflightReviewRuntime({ environment, engine = 'chromium' }, {
  executionResolver = resolveExecution, engineResolver = resolveEngine
} = {}, label) {
  try {
    return (await resolveRunRuntime({ environment, engine }, { executionResolver, engineResolver })).engineId;
  } catch (error) {
    if (!(error instanceof RuntimeUnavailableError)) throw error;
    if (error.code === 'ENGINE_UNAVAILABLE') {
      throw new PublicInputError(`${label} cannot start on the selected ${error.engineId} engine: ${error.reason} Install this browser on the QASE server or select another available browser.`, 422);
    }
    throw new PublicInputError(`${label} cannot start: ${error.message} Choose an available test environment.`, 422);
  }
}

export const preflightFounderRuntime = (input, dependencies) => preflightReviewRuntime(input, dependencies, 'Founder');
export const preflightSqaRuntime = (input, dependencies) => preflightReviewRuntime(input, dependencies, 'SQA');
export const preflightQaRuntime = (input, dependencies) => preflightReviewRuntime(input, dependencies, 'QA');
