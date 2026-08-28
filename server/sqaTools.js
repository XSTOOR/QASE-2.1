import {
	AGENT_EVIDENCE_TYPES,
	finishSqaAssessment,
	recordAgentSqaBlockers,
	recordAgentSqaObservation,
	recordAgentSqaObservations
} from './sqaService.js';
import { getSqaControl, SQA_TECHNICAL_CONTROL_IDS } from './sqaCatalog.js';

const AGENT_EVIDENCE_TYPE_VALUES = [...AGENT_EVIDENCE_TYPES];
const PUBLIC_ONLY_SCOPE = /\b(public[- ]only|anonymous[- ]only|unauthenticated[- ]only|login[- ]only|auth(?:entication)? surface only|continue without (?:credentials|sign[- ]?in))\b/i;
const AUTH_BLOCKED = /\b(behind authentication|authentication (?:is )?required|requires? (?:authentication|credentials|sign[- ]?in)|unauthenticated|no (?:login )?credentials?|cannot sign in|login (?:is )?required)\b/i;

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
	return { pendingControlIds, incompletePassIds, activeActivities, incompleteTodos, authBlockedControlIds };
}

export function createSqaTools(session, runStore) {
	const recordControl = {
		name: 'record_sqa_control',
		description: 'Records one scoped SQA control observation, or an atomic controls batch of up to 12 closely related observations. Capture a control-specific browser check immediately before pass/fail. Provide every required browser-eligible evidence type in evidence; manual and reviewer-only prerequisites remain blocked.',
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
					const results = await recordAgentSqaObservations(session, input.controls, runStore);
					return {
						success: true,
						recorded: results.map(result => `${result.controlId}: ${result.status}`),
						count: results.length,
						results: results.map(result => ({
							control_id: result.controlId,
							status: result.status,
							decision_notes: result.decisionNotes,
							evidence_coverage: result.evidenceCoverage
						}))
					};
				}
				const result = await recordAgentSqaObservation(session, input, runStore);
				return {
					success: true,
					recorded: `${result.controlId}: ${result.status}`,
					control_id: result.controlId,
					status: result.status,
					decision_notes: result.decisionNotes,
					evidence_coverage: result.evidenceCoverage
				};
			} catch (error) {
				return { success: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
	};

	const recordBlockers = {
		name: 'record_sqa_blockers',
		description: 'Records a bounded batch of reviewer-only or unavailable-prerequisite controls as blocked after browser-observable technical checks are complete. Give one precise missing prerequisite per control.',
		category: 'sqa',
		parametersSchema: {
			type: 'object',
			properties: {
				controls: {
					type: 'array', minItems: 1, maxItems: 50,
					items: {
						type: 'object',
						properties: {
							control_id: { type: 'string' },
							rationale: { type: 'string', description: 'Exact reviewed artifact, authorization, environment, account, or other prerequisite that is missing.' }
						},
						required: ['control_id', 'rationale']
					}
				}
			},
			required: ['controls']
		},
		async run(input) {
			try {
				const results = await recordAgentSqaBlockers(session, input?.controls, runStore);
				return {
					success: true,
					recorded: results.map(result => `${result.controlId}: ${result.status}`),
					count: results.length
				};
			} catch (error) {
				return { success: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
	};

	const finish = {
		name: 'finish_sqa_assessment',
		description: 'Ends the SQA run by invoking the deterministic verdict engine. Call once after every applicable control has a result. The result is a scoped technical assessment, never a certification or regulatory approval.',
		category: 'sqa',
		parametersSchema: { type: 'object', properties: {} },
		async run() {
			try {
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
				const readiness = finishReadiness(session);
				if (readiness.activeActivities.length > 0) {
					return {
						success: false,
						error: 'Browser checks are still running. Wait for their tool results before publishing.',
						active_activity_ids: readiness.activeActivities.map(item => item.id)
					};
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

	return [recordControl, recordBlockers, finish];
}

export { finishReadiness };
