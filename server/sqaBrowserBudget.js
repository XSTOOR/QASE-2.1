const DEFAULT_SQA_BROWSER_TOOL_BUDGET = 120;

function configuredBudget() {
	const value = Number(process.env.QASE_SQA_BROWSER_TOOL_BUDGET ?? DEFAULT_SQA_BROWSER_TOOL_BUDGET);
	return Number.isFinite(value) ? Math.max(20, Math.min(500, Math.floor(value))) : DEFAULT_SQA_BROWSER_TOOL_BUDGET;
}

export const SQA_BROWSER_TOOL_BUDGET = configuredBudget();

export function countSqaBrowserActivities(session) {
	return (session?.activities ?? []).filter(activity => (
		typeof activity?.toolName === 'string'
		&& activity.toolName.startsWith('browser_')
		&& activity.status !== 'running'
	)).length;
}

export function guardSqaBrowserTool(tool, session, limit = SQA_BROWSER_TOOL_BUDGET) {
	if (session?.mode !== 'sqa' || !tool?.name?.startsWith('browser_') || typeof tool.run !== 'function') return tool;
	return {
		...tool,
		async run(input, context) {
			const used = countSqaBrowserActivities(session);
			if (used >= limit) {
				return {
					success: false,
					code: 'SQA_BROWSER_BUDGET_EXHAUSTED',
					used,
					limit,
					error: `The SQA browser-tool budget is exhausted (${used}/${limit}). Do not call another browser tool. Record remaining browser-dependent controls as blocked with the evidence already collected, record reviewer-only blockers once, complete the plan, and call finish_sqa_assessment now.`
				};
			}
			return tool.run(input, context);
		}
	};
}
