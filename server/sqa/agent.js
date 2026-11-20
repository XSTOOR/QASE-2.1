/**
 * The compliance agent: the shared stage agent (../stageAgent.js) with the
 * SQA settings (QASE_SQA_REASONING, QASE_SQA_MAX_TURNS, QASE_SQA_SEARCH_URL).
 */
import { createStageAgent, stageModelSettings } from '../stageAgent.js';

export const sqaModelSettings = (settings, env = process.env) => stageModelSettings(settings, env, 'SQA');
export const createComplianceAgent = createStageAgent;
