import { AsyncLocalStorage } from 'node:async_hooks';

const GROUPS = Object.freeze({
	presentation: ['SQA-WEB-001', 'SQA-WEB-004', 'SQA-WEB-005', 'SQA-WEB-006'],
	interaction: ['SQA-WEB-002', 'SQA-WEB-003']
});

const failure = (code, error, extra = {}) => ({ success: false, code, error, ...extra });

/** Small continuation projection of matching host receipts, not model prose.
 * Retain concrete facts after SDK history compaction so a related control can
 * reuse an already observed oracle without repeating browser input. */
export function savedSqaSmokeContext(session) {
	const saved = ['navigation', 'form_validation'].flatMap(action => {
		const receipt = session.sqa?.smokeEvidence?.findLast(item => item.action === action
			&& ['pass', 'fail'].includes(item.verdict)
			&& session.activities?.some(activity => activity.id === item.activityId && activity.toolName === 'browser_sqa_smoke'
				&& activity.status === 'done' && activity.input?.action === action));
		if (!receipt) return [];
		const common = { activity_id: receipt.activityId, action, verdict: receipt.verdict };
		return [action === 'navigation' ? { ...common, samples: receipt.samples?.slice(0, 4).map(({ destination, ok, status, reason }) => ({ destination, ok, status, reason })) }
			: { ...common, cases: receipt.cases?.slice(0, 4).map(({ name, validity, submissionBlocked, feedbackChanged }) => ({
				name, validity: { valid: validity?.valid, required: validity?.required, failures: validity?.failures }, submissionBlocked, feedbackChanged
			})), stale_success_after_invalid: receipt.staleSuccessSignalAfterInvalid }];
	});
	if (!saved.length) return '';
	return `# Saved technical observations from this run
${JSON.stringify(saved)}
These matching completed host receipts survive history compaction. They describe bounded local samples, not broader assurance. Reuse a saved check only when the next control's exact objective and declared oracle match; give that control its own factual summary and retain its limitations. Recording a supported result from these facts needs no new snapshot or input replay. The existing evidence recorder still validates provenance and contracts. Missing reviewer artifacts remain blocked.`;
}

/** Compose existing SDK capabilities; every child retains its own guards,
 * activity, budget charge and host evidence receipt. No control verdicts are
 * inferred here. The model must review the returned checks before recording. */
export function createSqaSmokeWorkflow(session, { invoke, isCancelled = () => false }) {
	const owner = new AsyncLocalStorage();
	const token = Symbol('SQA smoke workflow');
	let running = false;
	const cancelled = signal => signal?.aborted || isCancelled();
	const tool = {
		name: 'run_sqa_smoke_workflow', category: 'sqa',
		description: 'PREFERRED for configured-provider SQA technical checks: presentation runs diagnostics, keyboard/semantics and responsive smoke in sequence; interaction runs observed same-origin navigation then isolated local form validation. Each child uses the normal SDK permission, budget and evidence gates and saves a separate activity. Review the returned facts, then immediately call record_sqa_control with one controls batch for the returned control_ids. This tool does not record verdicts, expand scope or replay attempted smoke checks. Native qualified mode uses mode_run_workflow instead.',
		parametersSchema: { type: 'object', additionalProperties: false, properties: {
			workflow: { type: 'string', enum: ['presentation', 'interaction'] },
			links: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 120 }, description: 'Required only for interaction: exact accessible same-origin link names from the observed page.' }
		}, required: ['workflow'] },
		async run(input, context = {}) {
			if (!input || typeof input !== 'object' || Array.isArray(input)
				|| !Object.hasOwn(GROUPS, input.workflow)
				|| Object.keys(input).some(key => !['workflow', 'links'].includes(key))
				|| (input.workflow === 'presentation' && input.links !== undefined)
				|| (input.workflow === 'interaction' && (!Array.isArray(input.links) || input.links.length < 1 || input.links.length > 4
					|| input.links.some(name => typeof name !== 'string' || !name.trim() || name.length > 120)))) {
				return failure('SQA_WORKFLOW_INPUT_INVALID', 'Choose presentation without links, or interaction with 1–4 exact observed link names. No other inputs are accepted.');
			}
			if (session.mode !== 'sqa' || !session.sqa?.scope || session.sqa.execution) {
				return failure('SQA_WORKFLOW_UNAVAILABLE', 'This composition is for configured-provider SQA only. Qualified mode retains its planned mode_run_workflow and matching evidence rules.');
			}
			if (session.sqa.finalizedAt || session.sqa.budgetCloseout || session.sqa.review?.status === 'in_review') {
				return failure('SQA_WORKFLOW_CLOSED', 'This assessment is closed or under reviewer control; browser work cannot restart through this tool.');
			}
			if (cancelled(context.signal)) return failure('SQA_WORKFLOW_CANCELLED', 'The workflow was cancelled before dispatch.');
			if (running) return failure('SQA_WORKFLOW_BUSY', 'A bounded SQA workflow is already running. Wait for its saved results.');
			if ((session.activities ?? []).some(activity => activity.toolName?.startsWith('browser_') && activity.status === 'running')) {
				return failure('SQA_WORKFLOW_INTERRUPTED', 'A prior browser action is still in flight or has an uncertain saved outcome. Inspect it before starting a workflow; no automatic replay is permitted.');
			}
			const scoped = new Set(session.sqa.scope.applicableControlIds);
			const recorded = new Map((session.sqa.observations ?? []).map(item => [item.controlId, item.status]));
			const controlIds = GROUPS[input.workflow].filter(id => scoped.has(id));
			if (!controlIds.length) return failure('SQA_WORKFLOW_OUT_OF_SCOPE', 'This workflow has no controls in the authorized assessment scope.');
			if (controlIds.some(id => recorded.has(id) && recorded.get(id) !== 'not_assessed')) {
				return failure('SQA_WORKFLOW_ALREADY_RECORDED', 'This group already has durable control results. Continue pending work without replaying it.', { control_ids: controlIds });
			}
			if (input.workflow === 'interaction' && GROUPS.presentation.some(id => scoped.has(id)
				&& (!recorded.has(id) || recorded.get(id) === 'not_assessed'))) {
				return failure('SQA_CONTROL_RESULT_REQUIRED', 'Review and record the presentation controls before starting the interaction workflow.', { control_ids: GROUPS.presentation.filter(id => scoped.has(id)) });
			}
			const actions = input.workflow === 'presentation' ? ['accessibility', 'responsive'] : ['navigation', 'form_validation'];
			if ((session.activities ?? []).some(activity => activity.toolName === 'browser_sqa_smoke' && actions.includes(activity.input?.action))) {
				return failure('SQA_WORKFLOW_ALREADY_ATTEMPTED', 'A smoke check in this group was already attempted. Inspect its saved result and use only the missing individual check if safe; never replay the group.', { control_ids: controlIds });
			}
			const steps = actions.map(action => ({ tool: 'browser_sqa_smoke', input: { action, ...(action === 'navigation' ? { links: input.links } : {}) } }));
			if (input.workflow === 'presentation') {
				steps.unshift({ tool: 'browser_diagnostics', input: {} });
			}
			running = true;
			const checks = [];
			const progress = () => ({ workflow: input.workflow, control_ids: controlIds, checks });
			try {
				return await owner.run(token, async () => {
					for (const step of steps) {
						if (cancelled(context.signal)) return failure('SQA_WORKFLOW_CANCELLED', 'The workflow was cancelled. Earlier child results remain saved; no later action was dispatched.', progress());
						const child = await invoke(step.tool, step.input, context.signal);
						if (!child?.activityId || !child.result || typeof child.result !== 'object') {
							return failure('SQA_WORKFLOW_RECEIPT_MISSING', 'A child did not return a saved result. Inspect the activity before deciding any further work; no automatic replay is permitted.', progress());
						}
						checks.push({ tool: step.tool, action: step.input.action, activity_id: child.activityId, result: child.result });
						if (child.result.success === false) {
							return failure(child.result.code ?? 'SQA_WORKFLOW_STEP_FAILED', child.result.error ?? 'A child check failed. No later workflow step was dispatched.', progress());
						}
					}
					if (cancelled(context.signal)) return failure('SQA_WORKFLOW_CANCELLED', 'The workflow was cancelled after its last saved check. No verdict was recorded.', progress());
					return { success: true, ...progress(), next: 'Review each control against these observations, then call record_sqa_control once with a controls batch. Missing or unverified evidence stays blocked; these checks do not grant a broader assurance pass.' };
				});
			} catch {
				return failure(cancelled(context.signal) ? 'SQA_WORKFLOW_CANCELLED' : 'SQA_WORKFLOW_INTERRUPTED', 'The workflow did not return a durable child result. Earlier saved activities remain; inspect them before using only missing capabilities. No automatic replay is permitted.', progress());
			} finally {
				running = false;
			}
		}
	};
	return { tool, dispatchAllowed: () => !running || owner.getStore() === token };
}
