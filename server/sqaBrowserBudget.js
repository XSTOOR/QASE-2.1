const DEFAULT_SQA_BROWSER_TOOL_BUDGET = 120;
// A normal SQA browser workflow is deliberately capped at four actions. Start
// the next workflow from durable host state as soon as that checkpoint is
// recorded instead of carrying several large snapshots into later controls.
const DEFAULT_SQA_CONTEXT_COMPACTION_ACTIVITY_INTERVAL = 1;
const DEFAULT_SQA_CONTEXT_COMPACTION_INPUT_TOKEN_INTERVAL = 50_000;
const DEFAULT_SQA_INPUT_TOKEN_BUDGET = 350_000;
const DEFAULT_SQA_BROWSER_WORKFLOW_CHECKPOINT = 4;

function configuredBudget() {
	const value = Number(process.env.QASE_SQA_BROWSER_TOOL_BUDGET ?? DEFAULT_SQA_BROWSER_TOOL_BUDGET);
	return Number.isFinite(value) ? Math.max(20, Math.min(500, Math.floor(value))) : DEFAULT_SQA_BROWSER_TOOL_BUDGET;
}

export const SQA_BROWSER_TOOL_BUDGET = configuredBudget();

function configuredCompactionInterval() {
	const value = Number(process.env.QASE_SQA_CONTEXT_COMPACTION_ACTIVITY_INTERVAL
		?? DEFAULT_SQA_CONTEXT_COMPACTION_ACTIVITY_INTERVAL);
	return Number.isFinite(value) ? Math.max(1, Math.min(60, Math.floor(value)))
		: DEFAULT_SQA_CONTEXT_COMPACTION_ACTIVITY_INTERVAL;
}

export const SQA_CONTEXT_COMPACTION_ACTIVITY_INTERVAL = configuredCompactionInterval();

function configuredCompactionInputTokenInterval() {
	const value = Number(process.env.QASE_SQA_CONTEXT_COMPACTION_INPUT_TOKEN_INTERVAL
		?? DEFAULT_SQA_CONTEXT_COMPACTION_INPUT_TOKEN_INTERVAL);
	return Number.isFinite(value) ? Math.max(50_000, Math.min(500_000, Math.floor(value)))
		: DEFAULT_SQA_CONTEXT_COMPACTION_INPUT_TOKEN_INTERVAL;
}

export const SQA_CONTEXT_COMPACTION_INPUT_TOKEN_INTERVAL = configuredCompactionInputTokenInterval();

function configuredInputTokenBudget() {
	const value = Number(process.env.QASE_SQA_INPUT_TOKEN_BUDGET ?? DEFAULT_SQA_INPUT_TOKEN_BUDGET);
	return Number.isFinite(value) ? Math.max(100_000, Math.min(5_000_000, Math.floor(value)))
		: DEFAULT_SQA_INPUT_TOKEN_BUDGET;
}

export const SQA_INPUT_TOKEN_BUDGET = configuredInputTokenBudget();

function configuredWorkflowCheckpoint() {
	const value = Number(process.env.QASE_SQA_BROWSER_WORKFLOW_CHECKPOINT
		?? DEFAULT_SQA_BROWSER_WORKFLOW_CHECKPOINT);
	return Number.isFinite(value) ? Math.max(2, Math.min(20, Math.floor(value)))
		: DEFAULT_SQA_BROWSER_WORKFLOW_CHECKPOINT;
}

export const SQA_BROWSER_WORKFLOW_CHECKPOINT = configuredWorkflowCheckpoint();

export function countSqaBrowserActivities(session) {
	return (session?.activities ?? []).filter(activity => (
		typeof activity?.toolName === 'string'
		&& activity.toolName.startsWith('browser_')
		&& activity.status !== 'running'
	)).length;
}

/** Completed browser actions since the latest durable technical-control write. */
export function countSqaBrowserActivitiesSinceControlCheckpoint(session) {
	const activities = session?.activities ?? [];
	const checkpoint = activities.findLastIndex(activity => (
		activity?.toolName === 'record_sqa_control' && activity.status === 'done'
	));
	return activities.slice(checkpoint + 1).filter(activity => (
		typeof activity?.toolName === 'string'
		&& activity.toolName.startsWith('browser_')
		&& activity.status === 'done'
	)).length;
}

/**
 * Long browser assessments otherwise resend an ever-growing tool transcript on
 * every model call. A completed workflow checkpoint may start a fresh model
 * context once this many new browser activities have accumulated. Durable
 * todos, observations, findings, messages, and live browser state remain the
 * source of truth, so compaction removes only redundant provider history.
 */
export function sqaContextCompactionDue(session, lastCompactedActivityCount = 0,
	interval = SQA_CONTEXT_COMPACTION_ACTIVITY_INTERVAL, lastCompactedInputTokens = 0,
	inputTokenInterval = SQA_CONTEXT_COMPACTION_INPUT_TOKEN_INTERVAL) {
	if (session?.mode !== 'sqa' || session.sqa?.finalizedAt) return false;
	if (!Array.isArray(session.sqa?.observations) || session.sqa.observations.length === 0) return false;
	const boundedInterval = Number.isFinite(Number(interval)) ? Math.max(1, Math.floor(Number(interval)))
		: SQA_CONTEXT_COMPACTION_ACTIVITY_INTERVAL;
	const boundedInputInterval = Number.isFinite(Number(inputTokenInterval))
		? Math.max(1, Math.floor(Number(inputTokenInterval)))
		: SQA_CONTEXT_COMPACTION_INPUT_TOKEN_INTERVAL;
	const activityGrowth = countSqaBrowserActivities(session) - Math.max(0, Number(lastCompactedActivityCount) || 0);
	const inputTokenGrowth = Math.max(0, Number(session.tokenUsage?.inputTokens) || 0)
		- Math.max(0, Number(lastCompactedInputTokens) || 0);
	return activityGrowth >= boundedInterval || inputTokenGrowth >= boundedInputInterval;
}

export function guardSqaBrowserTool(tool, session, limit = SQA_BROWSER_TOOL_BUDGET,
	inputTokenLimit = SQA_INPUT_TOKEN_BUDGET,
	workflowCheckpoint = SQA_BROWSER_WORKFLOW_CHECKPOINT) {
	if (session?.mode !== 'sqa' || !tool?.name?.startsWith('browser_') || typeof tool.run !== 'function') return tool;
	return {
		...tool,
		async run(input, context) {
			const inputTokens = Math.max(0, Number(session.tokenUsage?.inputTokens) || 0);
			if (inputTokens >= inputTokenLimit) {
				return {
					success: false,
					code: 'SQA_INPUT_TOKEN_BUDGET_EXHAUSTED',
					used: inputTokens,
					limit: inputTokenLimit,
					error: `The SQA input-token budget is exhausted (${inputTokens}/${inputTokenLimit}). Do not call another browser tool. Call finish_sqa_assessment once with close_after_safety_limit=true; the host will conservatively block pending controls, complete the plan, and publish without inventing evidence.`
				};
			}
			const used = countSqaBrowserActivities(session);
			if (used >= limit) {
				return {
					success: false,
					code: 'SQA_BROWSER_BUDGET_EXHAUSTED',
					used,
					limit,
					error: `The SQA browser-tool budget is exhausted (${used}/${limit}). Do not call another browser tool. Call finish_sqa_assessment once with close_after_safety_limit=true; the host will conservatively block pending controls, complete the plan, and publish without inventing evidence.`
				};
			}
			const hasDurableTechnicalResult = (session.sqa?.observations ?? [])
				.some(observation => observation.status !== 'not_assessed');
			const workflowUsed = countSqaBrowserActivitiesSinceControlCheckpoint(session);
			if (hasDurableTechnicalResult && workflowUsed >= workflowCheckpoint) {
				return {
					success: false,
					code: 'SQA_WORKFLOW_CHECKPOINT_REQUIRED',
					used: workflowUsed,
					limit: workflowCheckpoint,
					error: `This bounded SQA workflow has used ${workflowUsed}/${workflowCheckpoint} browser actions since the last control result. Do not explore further yet. Record the just-completed workflow immediately with record_sqa_control (pass, fail, or a precise blocker), update the plan if needed, then continue.`
				};
			}
			return tool.run(input, context);
		}
	};
}
