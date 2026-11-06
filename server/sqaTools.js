import { guardFinalization } from './finalizationGuard.js';
import { modeExplorationReadiness } from './modeReasoningRuntime.js';
import {
	AGENT_EVIDENCE_TYPES,
	closePendingReviewerSqaControlsAsBlocked,
	closePendingSqaControlsAsBlocked,
	finishSqaAssessment,
	recordAgentSqaObservation,
	recordAgentSqaObservations,
	pendingAgentSqaControlIds
} from './sqaService.js';
import { getSqaControl, SQA_TECHNICAL_CONTROL_IDS } from './sqaCatalog.js';
import {
	countSqaBrowserActivities,
	SQA_BROWSER_EVIDENCE_LIMIT,
	SQA_BROWSER_TOOL_BUDGET,
	SQA_INPUT_TOKEN_BUDGET,
	SQA_INPUT_TOKEN_CLOSEOUT_THRESHOLD
} from './sqaBrowserBudget.js';

const AGENT_EVIDENCE_TYPE_VALUES = [...AGENT_EVIDENCE_TYPES];
const PUBLIC_ONLY_SCOPE = /\b(public[- ]only|anonymous[- ]only|unauthenticated[- ]only|login[- ]only|auth(?:entication)? surface only|continue without (?:credentials|sign[- ]?in))\b/i;
const AUTH_BLOCKED = /\b(behind authentication|authentication (?:is )?required|requires? (?:authentication|credentials|sign[- ]?in)|unauthenticated|no (?:login )?credentials?|cannot sign in|login (?:is )?required)\b/i;

function pendingTechnicalControlIds(session) {
	const applicable = new Set(session.sqa?.scope?.applicableControlIds ?? []);
	const recorded = new Map((session.sqa?.observations ?? []).map(item => [item.controlId, item.status]));
	return SQA_TECHNICAL_CONTROL_IDS.filter(controlId => (
		applicable.has(controlId) && (!recorded.has(controlId) || recorded.get(controlId) === 'not_assessed')
	));
}

function requireTechnicalControlsFirst(session, proposedControlIds) {
	const pending = pendingTechnicalControlIds(session);
	if (pending.length === 0 || proposedControlIds.every(controlId => SQA_TECHNICAL_CONTROL_IDS.includes(controlId))) return;
	throw new TypeError(`Finish the six technical web controls first. Pending: ${pending.join(', ')}. Record non-technical controls only after these have results.`);
}

function finishReadiness(session, now = Date.now()) {
	const observations = new Map((session.sqa?.observations ?? []).map(item => [item.controlId, item]));
	const pendingControlIds = [];
	const incompletePassIds = [];
	for (const controlId of session.sqa?.scope?.applicableControlIds ?? []) {
		const observation = observations.get(controlId);
		if (!observation || observation.status === 'not_assessed') {
			pendingControlIds.push(controlId);
			continue;
		}
		if (observation.status === 'pass') {
			const control = getSqaControl(controlId);
			const complete = control.evidenceRequirements.every(requirement => (
				observation.evidence?.filter(item => item.type === requirement.type).length >= requirement.minimum
			));
			if (!complete) incompletePassIds.push(controlId);
		}
	}
	const activeActivities = (session.activities ?? []).filter(activity => (
		activity.status === 'running'
		&& activity.toolName !== 'finish_sqa_assessment'
		&& Number.isFinite(Number(activity.ts))
		&& now - Number(activity.ts) < 120_000
	));
	const incompleteTodos = (session.todos ?? []).filter(todo => (
		todo.status !== 'completed'
		&& !(todo.status === 'in_progress' && /\b(finish|publish)\b.*\b(SQA|assessment|report)\b/i.test(todo.text ?? ''))
	));
	const userScopeText = (session.messages ?? [])
		.filter(message => message.role === 'user')
		.map(message => message.text)
		.join(' ');
	const explicitlyPublicOnly = PUBLIC_ONLY_SCOPE.test(`${session.sqa?.scope?.scopeNotes ?? ''} ${userScopeText}`);
	const authBlockedControlIds = explicitlyPublicOnly ? [] : (session.sqa?.observations ?? [])
		.filter(item => SQA_TECHNICAL_CONTROL_IDS.includes(item.controlId)
			&& item.status === 'blocked'
			&& AUTH_BLOCKED.test(item.rationale ?? ''))
		.map(item => item.controlId);
	const findingControlConflicts = (session.findings ?? []).flatMap(finding => (
		(finding.controlIds ?? [])
			.filter(controlId => observations.get(controlId)?.status !== 'fail')
			.map(controlId => ({ findingId: finding.id, title: finding.title, controlId,
				observedStatus: observations.get(controlId)?.status ?? 'pending' }))
	));
	return {
		pendingControlIds,
		incompletePassIds,
		activeActivities,
		incompleteTodos,
		authBlockedControlIds,
		findingControlConflicts
	};
}

export function createSqaTools(session, runStore, options = {}) {
	async function automaticReviewerCloseout() {
		const pendingBrowserControlIds = pendingAgentSqaControlIds(session);
		if (pendingBrowserControlIds.length > 0) {
			return { closed_count: 0, pending_browser_count: pendingBrowserControlIds.length };
		}
		const closed = await closePendingReviewerSqaControlsAsBlocked(session, runStore);
		return { closed_count: closed.length };
	}

	const recordControl = {
		name: 'record_sqa_control',
		description: 'Records one scoped SQA control observation, or an atomic controls batch of up to 12 closely related observations. Capture a control-specific browser check immediately before pass/fail. Provide every required browser-eligible evidence type in evidence. After the final browser-eligible result, the host automatically closes every still-pending reviewer-only prerequisite with its catalog-derived missing-evidence reason.',
		category: 'sqa',
		parametersSchema: {
			type: 'object',
			properties: {
				controls: {
					type: 'array', minItems: 1, maxItems: 12,
					description: 'Optional atomic batch for closely related controls supported by the immediately preceding browser workflow. Do not combine with the single-control fields.',
					items: {
						type: 'object',
						properties: {
							control_id: { type: 'string', description: 'Exact SQA control ID from the assessment scope.' },
							status: { type: 'string', enum: ['pass', 'fail', 'blocked', 'not_assessed'] },
							rationale: { type: 'string', description: 'Required for fail or blocked. State the concrete result or missing prerequisite.' },
							evidence: {
								type: 'array', maxItems: 10,
								items: {
									type: 'object',
									properties: {
										type: { type: 'string', enum: AGENT_EVIDENCE_TYPE_VALUES },
										summary: { type: 'string', description: 'Control-specific factual summary; never include credentials, personal data, or cookies.' }
									},
									required: ['type']
								}
							}
						},
						required: ['control_id', 'status']
					}
				},
				control_id: { type: 'string', description: 'Exact SQA control ID from the assessment scope.' },
				status: { type: 'string', enum: ['pass', 'fail', 'blocked', 'not_assessed'] },
				rationale: { type: 'string', description: 'Required for fail or blocked. State the concrete result or missing prerequisite.' },
				evidence: {
					type: 'array', maxItems: 10,
					description: 'Evidence for pass/fail or useful partial evidence for blocked. Include all required eligible types for pass.',
					items: {
						type: 'object',
						properties: {
							type: { type: 'string', enum: AGENT_EVIDENCE_TYPE_VALUES },
							summary: { type: 'string', description: 'Short factual description; never include credentials, personal data, or cookies.' }
						},
						required: ['type']
					}
				},
				evidence_type: { type: 'string', enum: AGENT_EVIDENCE_TYPE_VALUES, description: 'Compatibility field for a single evidence item; do not combine with evidence.' },
				evidence_summary: { type: 'string', description: 'Compatibility summary paired with evidence_type.' }
			},
			required: []
		},
		async run(input) {
			try {
				if (input?.controls !== undefined) {
					const hasSingleFields = ['control_id', 'status', 'rationale', 'evidence', 'evidence_type', 'evidence_summary']
						.some(field => input?.[field] !== undefined);
					if (hasSingleFields) {
						throw new TypeError('Use either controls or the single-control fields, not both.');
					}
					requireTechnicalControlsFirst(session, Array.isArray(input.controls)
						? input.controls.map(item => item?.control_id)
						: []);
					const results = await recordAgentSqaObservations(session, input.controls, runStore);
					const reviewerCloseout = await automaticReviewerCloseout();
					return {
						success: true,
						recorded: results.map(result => `${result.controlId}: ${result.status}`),
						count: results.length,
						results: results.map(result => ({
							control_id: result.controlId,
							status: result.status,
							decision_notes: result.decisionNotes,
							evidence_coverage: result.evidenceCoverage
						})),
						reviewer_closeout: reviewerCloseout
					};
				}
				requireTechnicalControlsFirst(session, [input?.control_id]);
				const result = await recordAgentSqaObservation(session, input, runStore);
				const reviewerCloseout = await automaticReviewerCloseout();
				return {
					success: true,
					recorded: `${result.controlId}: ${result.status}`,
					control_id: result.controlId,
					status: result.status,
					decision_notes: result.decisionNotes,
					evidence_coverage: result.evidenceCoverage,
					reviewer_closeout: reviewerCloseout
				};
			} catch (error) {
				return { success: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
	};

	const recordBlockers = {
		name: 'record_sqa_blockers',
		description: 'Fallback reviewer closeout. Normally the host runs this automatically after the final browser-eligible control. If needed, call once with close_remaining=true; the host identifies all pending reviewer-only controls and derives each precise missing-evidence reason from the catalog. Never enumerate controls or write blocker rationales.',
		category: 'sqa',
		parametersSchema: {
			type: 'object', additionalProperties: false,
			properties: {
				close_remaining: { type: 'boolean', enum: [true], description: 'Close every pending reviewer-only prerequisite using its host catalog evidence contract.' }
			},
			required: ['close_remaining']
		},
		async run(input) {
			try {
				if (input?.close_remaining !== true || Object.keys(input ?? {}).some(key => key !== 'close_remaining')) {
					throw new TypeError('Call reviewer closeout once with close_remaining=true; do not enumerate controls or rationales.');
				}
				const results = await closePendingReviewerSqaControlsAsBlocked(session, runStore);
				return {
					success: true,
					closed_count: results.length,
					remaining_pending_control_ids: finishReadiness(session).pendingControlIds
				};
			} catch (error) {
				return { success: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
	};

	const finish = {
		name: 'finish_sqa_assessment',
		description: 'Ends the SQA run by invoking the deterministic verdict engine. Call once after every applicable control has a result. At the reserved evidence/input closeout threshold, set close_from_saved_evidence=true; after a hard safety limit, set close_after_safety_limit=true. The host durably blocks only pending controls with the exact reason, completes the plan, and publishes without inventing evidence. The result is a scoped technical assessment, never a certification or regulatory approval.',
		category: 'sqa',
		parametersSchema: {
			type: 'object', additionalProperties: false,
			properties: {
				close_from_saved_evidence: { type: 'boolean', description: 'Use only after the host reports the SQA evidence-collection or input-token closeout threshold is reached.' },
				close_after_safety_limit: { type: 'boolean', description: 'Use only after the host reports the SQA browser-tool or input-token safety limit is exhausted.' }
			}
		},
		async run(input = {}) {
			try {
				if (session.sqa?.review?.status === 'in_review') return { success: false, error: 'An authorized reviewer must publish this review draft.' };
				if (session.sqa?.finalizedAt && session.sqa?.assessment) {
					return {
						success: true,
						published: true,
						already_finalized: true,
						assessment_id: session.sqa.assessment.assessmentId,
						verdict: session.sqa.assessment.verdict,
						coverage: session.sqa.assessment.coverage,
						risk: session.sqa.assessment.risk,
						disclaimer: session.sqa.assessment.disclaimer
					};
				}
				const exploration = modeExplorationReadiness(session);
				if (!exploration.ready) return { success: false, error: 'Qualified SQA requires observed page exploration, an executed reversible interaction, and diagnostics before publication.', exploration };
				let readiness = finishReadiness(session);
				if (readiness.activeActivities.length > 0) {
					return {
						success: false,
						error: 'Browser checks are still running. Wait for their tool results before publishing.',
						active_activity_ids: readiness.activeActivities.map(item => item.id)
					};
				}
				if (readiness.findingControlConflicts.length > 0) {
					return {
						success: false,
						error: 'A confirmed SQA finding contradicts a linked control result. Every control linked by report_finding must be recorded as fail before publication.',
						finding_control_conflicts: readiness.findingControlConflicts
					};
				}
				let safetyClosedControlIds = [];
				const closeFromSavedEvidence = input?.close_from_saved_evidence === true;
				const closeAfterSafetyLimit = input?.close_after_safety_limit === true;
				if (closeFromSavedEvidence && closeAfterSafetyLimit) {
					return { success: false, error: 'Choose one SQA budget closeout path, not both.' };
				}
				if (closeFromSavedEvidence || closeAfterSafetyLimit) {
					const inputTokens = Math.max(0, Number(session.tokenUsage?.inputTokens) || 0);
					const browserTools = countSqaBrowserActivities(session);
					const tokenLimitReached = inputTokens >= SQA_INPUT_TOKEN_BUDGET;
					const browserLimitReached = browserTools >= SQA_BROWSER_TOOL_BUDGET;
					const tokenCloseoutReached = inputTokens >= SQA_INPUT_TOKEN_CLOSEOUT_THRESHOLD;
					const browserCloseoutReached = browserTools >= SQA_BROWSER_EVIDENCE_LIMIT;
					const closeoutAllowed = closeAfterSafetyLimit
						? tokenLimitReached || browserLimitReached
						: tokenCloseoutReached || browserCloseoutReached;
					if (!closeoutAllowed) {
						return {
							success: false,
							error: closeAfterSafetyLimit
								? 'Safety closeout is available only after the host SQA input-token or browser-tool hard limit is exhausted.'
								: 'Saved-evidence closeout is available only after the host SQA evidence-collection or input-token closeout threshold is reached.',
							input_tokens: inputTokens,
							input_token_closeout_threshold: SQA_INPUT_TOKEN_CLOSEOUT_THRESHOLD,
							input_token_limit: SQA_INPUT_TOKEN_BUDGET,
							browser_tools: browserTools,
							browser_evidence_limit: SQA_BROWSER_EVIDENCE_LIMIT,
							browser_tool_limit: SQA_BROWSER_TOOL_BUDGET
						};
					}
					if (readiness.authBlockedControlIds.length >= 2) {
						return {
							success: false,
							requires_user_input: true,
							error: 'Authentication prevented representative scoped workflows. Call ask_question for vaulted credentials, or ask the user to explicitly confirm an anonymous/public-surface-only assessment before publishing.',
							auth_blocked_control_ids: readiness.authBlockedControlIds
						};
					}
					const trigger = tokenLimitReached || (!browserLimitReached && tokenCloseoutReached)
						? 'input_tokens' : 'browser_tools';
					const used = trigger === 'input_tokens' ? inputTokens : browserTools;
					const threshold = closeAfterSafetyLimit
						? (trigger === 'input_tokens' ? SQA_INPUT_TOKEN_BUDGET : SQA_BROWSER_TOOL_BUDGET)
						: (trigger === 'input_tokens' ? SQA_INPUT_TOKEN_CLOSEOUT_THRESHOLD : SQA_BROWSER_EVIDENCE_LIMIT);
					const hardLimit = trigger === 'input_tokens' ? SQA_INPUT_TOKEN_BUDGET : SQA_BROWSER_TOOL_BUDGET;
					const limitName = closeAfterSafetyLimit ? 'hard safety limit was exhausted' : 'reserved closeout threshold was reached';
					const reason = `Stopped early: budget reached. The host SQA ${trigger === 'input_tokens' ? 'input-token' : 'browser evidence-collection'} ${limitName} (${used}/${threshold}; hard limit ${hardLimit}) before control-specific evidence was collected. Conservatively blocked; no pass or fail is claimed.`;
					const previousBudgetCloseout = session.sqa.budgetCloseout;
					session.sqa = {
						...session.sqa,
						budgetCloseout: {
							mode: closeAfterSafetyLimit ? 'safety_limit' : 'saved_evidence',
							trigger,
							used,
							threshold,
							hardLimit
						}
					};
					let closed;
					try {
						closed = await closePendingSqaControlsAsBlocked(session, reason, runStore);
					} catch (error) {
						if (previousBudgetCloseout === undefined) delete session.sqa.budgetCloseout;
						else session.sqa.budgetCloseout = previousBudgetCloseout;
						throw error;
					}
					safetyClosedControlIds = closed.map(result => result.controlId);
					if ((session.todos ?? []).some(todo => todo.status !== 'completed')) {
						session.todos = session.todos.map(todo => ({ ...todo, status: 'completed' }));
						await runStore.commit(session, 'todos', { todos: session.todos, budgetCloseout: session.sqa.budgetCloseout });
					}
					readiness = finishReadiness(session);
				}
				if (readiness.incompleteTodos.length > 0) {
					return {
						success: false,
						error: 'The SQA plan still has unfinished technical checks. Complete them before publishing.',
						unfinished_todos: readiness.incompleteTodos.map(item => item.text)
					};
				}
				if (readiness.pendingControlIds.length > 0 || readiness.incompletePassIds.length > 0) {
					return {
						success: false,
						error: 'Every applicable control must have a defensible result, and each claimed pass must include its complete evidence contract.',
						pending_control_ids: readiness.pendingControlIds,
						incomplete_pass_control_ids: readiness.incompletePassIds
					};
				}
				if (readiness.authBlockedControlIds.length >= 2) {
					return {
						success: false,
						requires_user_input: true,
						error: 'Authentication prevented representative scoped workflows. Call ask_question for vaulted credentials, or ask the user to explicitly confirm an anonymous/public-surface-only assessment before publishing.',
						auth_blocked_control_ids: readiness.authBlockedControlIds
					};
				}
				const assessment = await finishSqaAssessment(session, runStore);
				return {
					success: true,
					published: true,
					budget_closeout: session.sqa?.budgetCloseout ?? null,
					safety_closeout: session.sqa?.budgetCloseout?.mode === 'safety_limit',
					safety_closed_control_ids: safetyClosedControlIds,
					assessment_id: assessment.assessmentId,
					verdict: assessment.verdict,
					coverage: assessment.coverage,
					risk: assessment.risk,
					disclaimer: assessment.disclaimer
				};
			} catch (error) {
				return { success: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
	};

	return [recordControl, recordBlockers, guardFinalization(finish, session, options)];
}

export { finishReadiness };
