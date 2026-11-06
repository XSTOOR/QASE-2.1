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

// Stop ordinary evidence collection before the hard safety limits so the run
// can publish from durable results instead of spending its final turn in a
// repeated browser/model retry loop. The hard limits remain a last-resort net.
export const SQA_BROWSER_EVIDENCE_LIMIT = Math.max(1,
	SQA_BROWSER_TOOL_BUDGET - Math.max(20, Math.floor(SQA_BROWSER_TOOL_BUDGET / 4)));
export const SQA_INPUT_TOKEN_CLOSEOUT_THRESHOLD = Math.max(1,
	SQA_INPUT_TOKEN_BUDGET - Math.max(50_000, Math.floor(SQA_INPUT_TOKEN_BUDGET / 7)));

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

export function sqaExecutionBudget(session) {
	const browserToolsUsed = countSqaBrowserActivities(session);
	const inputTokensUsed = Math.max(0, Number(session?.tokenUsage?.inputTokens) || 0);
	return {
		browserTools: {
			used: browserToolsUsed,
			evidenceLimit: SQA_BROWSER_EVIDENCE_LIMIT,
			hardLimit: SQA_BROWSER_TOOL_BUDGET,
			remainingForEvidence: Math.max(0, SQA_BROWSER_EVIDENCE_LIMIT - browserToolsUsed)
		},
		inputTokens: {
			used: inputTokensUsed,
			closeoutThreshold: SQA_INPUT_TOKEN_CLOSEOUT_THRESHOLD,
			hardLimit: SQA_INPUT_TOKEN_BUDGET,
			remainingBeforeCloseout: Math.max(0, SQA_INPUT_TOKEN_CLOSEOUT_THRESHOLD - inputTokensUsed)
		},
		...(session?.sqa?.budgetCloseout ? { closeout: { ...session.sqa.budgetCloseout } } : {})
	};
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

const SQA_PRESENTATION_WORKFLOW_CONTROLS = Object.freeze([
	'SQA-WEB-001',
	'SQA-WEB-004',
	'SQA-WEB-005',
	'SQA-WEB-006'
]);
const SQA_INTERACTION_WORKFLOW_CONTROLS = Object.freeze([
	'SQA-WEB-002',
	'SQA-WEB-003'
]);

function pendingControlIds(session, controlIds) {
	const applicable = Array.isArray(session?.sqa?.scope?.applicableControlIds)
		? new Set(session.sqa.scope.applicableControlIds)
		: new Set([...SQA_PRESENTATION_WORKFLOW_CONTROLS, ...SQA_INTERACTION_WORKFLOW_CONTROLS]);
	const recorded = new Map((session?.sqa?.observations ?? [])
		.map(observation => [observation?.controlId, observation?.status]));
	return controlIds.filter(controlId => (
		applicable.has(controlId)
		&& (!recorded.has(controlId) || recorded.get(controlId) === 'not_assessed')
	));
}

function smokeWorkflowCompleted(session, action) {
	const summaryPrefix = {
		accessibility: 'Accessibility smoke:',
		responsive: 'Responsive smoke:',
		navigation: 'Navigation smoke:',
		form_validation: 'Form smoke'
	}[action];
	return (session?.activities ?? []).some(activity => (
		activity?.toolName === 'browser_sqa_smoke'
		&& activity.input?.action === action
		&& (activity.status === 'done'
			|| (activity.status === 'failed' && String(activity.summary ?? '').startsWith(summaryPrefix)))
	));
}

function isRequestedSmoke(toolName, input, action) {
	return toolName === 'browser_sqa_smoke' && input?.action === action;
}

function requireControlWrite(controlIds, workflow) {
	return {
		success: false,
		code: 'SQA_CONTROL_RESULT_REQUIRED',
		control_ids: controlIds,
		error: `The bounded ${workflow} workflow is complete. Do not run or retry another browser action. Record ${controlIds.join(', ')} now with record_sqa_control using the observed pass, fail, or precise blocker result.`
	};
}

function requireNextSmoke(action, controlIds) {
	return {
		success: false,
		code: 'SQA_NEXT_BOUNDED_WORKFLOW_REQUIRED',
		required_tool: 'browser_sqa_smoke',
		required_action: action,
		control_ids: controlIds,
		error: `The paired SQA workflow is waiting for browser_sqa_smoke action=${action}. Do not use ordinary browser exploration or repeat the completed check. Run that one bounded action next, then record ${controlIds.join(', ')} with record_sqa_control.`
	};
}

/**
 * Keeps each deterministic SQA smoke pair atomic. Once a bounded workflow has
 * produced a result, model-directed exploration cannot dilute or repeat that
 * evidence before the matching controls are durably recorded.
 */
export function sqaWorkflowGate(session, toolName, input) {
	if (session?.mode !== 'sqa' || !String(toolName ?? '').startsWith('browser_')) return undefined;

	const pendingPresentation = pendingControlIds(session, SQA_PRESENTATION_WORKFLOW_CONTROLS);
	const accessibilityComplete = smokeWorkflowCompleted(session, 'accessibility');
	const responsiveComplete = smokeWorkflowCompleted(session, 'responsive');
	if (pendingPresentation.length > 0 && responsiveComplete) {
		return requireControlWrite(pendingPresentation, 'accessibility and responsive');
	}
	if (pendingPresentation.length > 0 && accessibilityComplete
		&& !isRequestedSmoke(toolName, input, 'responsive')) {
		return requireNextSmoke('responsive', pendingPresentation);
	}

	const pendingInteraction = pendingControlIds(session, SQA_INTERACTION_WORKFLOW_CONTROLS);
	const navigationComplete = smokeWorkflowCompleted(session, 'navigation');
	const formComplete = smokeWorkflowCompleted(session, 'form_validation');
	if (pendingInteraction.includes('SQA-WEB-003') && formComplete) {
		const readyToRecord = navigationComplete
			? pendingInteraction
			: pendingInteraction.filter(controlId => controlId === 'SQA-WEB-003');
		return requireControlWrite(readyToRecord, navigationComplete ? 'navigation and form-validation' : 'form-validation');
	}
	if (navigationComplete && pendingInteraction.includes('SQA-WEB-003')) {
		if (isRequestedSmoke(toolName, input, 'form_validation')) return undefined;
		return requireNextSmoke('form_validation', pendingInteraction);
	}
	if (navigationComplete && pendingInteraction.includes('SQA-WEB-002')) {
		return requireControlWrite(pendingInteraction.filter(controlId => controlId === 'SQA-WEB-002'), 'navigation');
	}
	return undefined;
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
			const evidenceLimit = limit === SQA_BROWSER_TOOL_BUDGET
				? SQA_BROWSER_EVIDENCE_LIMIT
				: Math.max(1, limit - Math.max(20, Math.floor(limit / 4)));
			const tokenCloseoutThreshold = inputTokenLimit === SQA_INPUT_TOKEN_BUDGET
				? SQA_INPUT_TOKEN_CLOSEOUT_THRESHOLD
				: Math.max(1, inputTokenLimit - Math.max(50_000, Math.floor(inputTokenLimit / 7)));
			if (inputTokens >= tokenCloseoutThreshold) {
				return {
					success: false,
					code: 'SQA_INPUT_TOKEN_CLOSEOUT_REQUIRED',
					used: inputTokens,
					threshold: tokenCloseoutThreshold,
					limit: inputTokenLimit,
					error: `The SQA input-token closeout threshold is reached (${inputTokens}/${tokenCloseoutThreshold}; hard limit ${inputTokenLimit}). Do not call another browser tool. Call finish_sqa_assessment once with close_from_saved_evidence=true; the host will conservatively block only pending controls, complete the plan, and publish without inventing evidence.`
				};
			}
			if (used >= evidenceLimit) {
				return {
					success: false,
					code: 'SQA_EVIDENCE_COLLECTION_COMPLETE',
					used,
					threshold: evidenceLimit,
					limit,
					error: `The SQA evidence-collection limit is reached (${used}/${evidenceLimit}; hard limit ${limit}). Do not call another browser tool. Call finish_sqa_assessment once with close_from_saved_evidence=true; the host will conservatively block only pending controls, complete the plan, and publish without inventing evidence.`
				};
			}
			const workflowBlock = sqaWorkflowGate(session, tool.name, input);
			if (workflowBlock) return workflowBlock;
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
