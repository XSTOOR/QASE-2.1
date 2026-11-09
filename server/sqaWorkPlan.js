import { getSqaControl, SQA_TECHNICAL_CONTROL_IDS } from './sqaCatalog.js';
import { AGENT_EVIDENCE_TYPES } from './sqaService.js';
import { sqaReportModel } from '../public/sqaReportModel.js';
import { BROWSER_WORKFLOW_GUIDANCE } from './browserWorkflowPrompt.js';

const severity = { critical: 0, high: 1, medium: 2, low: 3 };
const priority = (a, b) => Number(b.mandatory) - Number(a.mandatory)
	|| severity[a.severity] - severity[b.severity] || a.id.localeCompare(b.id);
const types = requirements => [...new Set(requirements.map(item => item.type))];

/** Derived guidance only: never changes observations, budgets or host gates. */
export function buildSqaWorkPlan(sqa) {
	if (!Array.isArray(sqa?.scope?.applicableControlIds)) return null;
	const controls = sqa.scope.applicableControlIds.map(id => getSqaControl(id));
	if (controls.some(control => !control)) throw new TypeError('SQA work plan requires known scoped controls.');
	const recorded = new Map((sqa.observations ?? []).map(item => [item.controlId, item.status]));
	const pending = controls.filter(control => !recorded.has(control.id) || recorded.get(control.id) === 'not_assessed');
	const browser = control => control.evidenceRequirements.some(item => AGENT_EVIDENCE_TYPES.has(item.type));
	const reviewer = control => control.evidenceRequirements.some(item => !AGENT_EVIDENCE_TYPES.has(item.type));
	const technical = SQA_TECHNICAL_CONTROL_IDS.map(id => pending.find(control => control.id === id)).filter(Boolean);
	const other = pending.filter(control => browser(control) && !SQA_TECHNICAL_CONTROL_IDS.includes(control.id));
	const browserOnly = other.filter(control => !reviewer(control)).sort(priority);
	const mixed = other.filter(reviewer).sort(priority);
	const prioritized = [...other].sort(priority);
	const reviewerOnly = pending.filter(control => !browser(control)).sort(priority);
	let phase = technical.length ? 'technical' : browserOnly.length ? 'browser' : mixed.length ? 'mixed'
		: reviewerOnly.length ? 'reviewer' : 'ready_for_publication';
	if (sqa.budgetCloseout) phase = 'budget_closed';
	if (sqa.finalizedAt) phase = 'finalized';
	const closed = ['budget_closed', 'finalized'].includes(phase);
	const active = closed ? [] : technical.length ? technical : prioritized.slice(0, 4);
	const pendingBrowser = [...technical, ...prioritized];
	const describe = control => ({
		id: control.id, title: control.title, objective: control.objective, severity: control.severity,
		mandatory: control.mandatory, requirements: control.evidenceRequirements.map(item => ({ ...item,
			owner: AGENT_EVIDENCE_TYPES.has(item.type) ? 'browser' : 'reviewer' }))
	});
	const results = sqa.assessment?.results ?? controls.map(control => ({
		controlId: control.id, title: control.title, status: recorded.get(control.id) ?? 'not_assessed',
		severity: control.severity, mandatory: control.mandatory,
		evidenceCoverage: { requirements: control.evidenceRequirements.map(item => ({ ...item, actual: 0, satisfied: false })) }
	}));
	return {
		phase,
		pendingControlIds: pending.map(control => control.id),
		pendingBrowserCount: pendingBrowser.length,
		pendingReviewerOnlyCount: reviewerOnly.length,
		activeControls: active.map(describe),
		pendingBrowserControls: pendingBrowser.map(describe),
		// Retain a planning index for ALL remaining browser controls. A window
		// prioritizes detail; it cannot reduce scope or authorize workflow replay.
		planningIndex: pendingBrowser.filter(control => !active.includes(control)).map(control => ({
			id: control.id, title: control.title,
			browser: types(control.evidenceRequirements.filter(item => AGENT_EVIDENCE_TYPES.has(item.type))),
			reviewer: types(control.evidenceRequirements.filter(item => !AGENT_EVIDENCE_TYPES.has(item.type)))
		})),
		reviewerRequests: sqaReportModel({ results }).evidenceRequests.filter(item => item.owner === 'reviewer')
	};
}

export function sqaWorkBrief(sqa) {
	const plan = buildSqaWorkPlan(sqa);
	if (!plan) return '';
	const active = plan.activeControls.map(({ requirements, ...control }) => ({ ...control,
		requirements: requirements.map(({ id, type, minimum, owner }) => ({ id, type, minimum, owner })) }));
	return `SQA work priority: ${plan.phase}. Pending browser controls: ${plan.pendingBrowserCount}; pending reviewer-only controls: ${plan.pendingReviewerOnlyCount}.
Detailed active controls: ${JSON.stringify(active)}
Remaining browser planning index: ${JSON.stringify(plan.planningIndex)}
Reviewer artifact requests: ${plan.reviewerRequests.length}. Read mode_execution_progress with sqa_view=reviewer for exact requirement IDs, types, minimum counts and descriptions; use next_offset for further pages.
The active window prioritizes detail, not authorized scope. Plan all relevant observed workflows; read mode_execution_progress with sqa_view=browser for further objectives. Reuse completed workflow evidence only when its control-specific host receipts match. Never replay completed work merely to refresh context. Closed or finalized runs cannot resume exploration through this queue.`;
}

/** Four catalog entries per read keeps detailed requirements out of every turn. */
export function readSqaWorkPage(sqa, { sqa_view, offset = 0 } = {}) {
	if (!['browser', 'reviewer', 'media'].includes(sqa_view) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000) {
		throw new TypeError('Choose browser, reviewer or media guidance and an integer offset from 0 to 1000.');
	}
	const plan = buildSqaWorkPlan(sqa);
	if (!plan) throw new TypeError('SQA work planning requires a resolved scope.');
	const entries = sqa_view === 'media' ? [{ guidance: BROWSER_WORKFLOW_GUIDANCE }] : sqa_view === 'browser' ? plan.pendingBrowserControls : plan.reviewerRequests;
	const next = offset + 4;
	return { phase: plan.phase, view: sqa_view, total: entries.length, items: entries.slice(offset, next),
		next_offset: next < entries.length ? next : null,
		closed: ['budget_closed', 'finalized'].includes(plan.phase),
		authority: 'Guidance only; existing evidence, workflow, recovery and budget gates remain authoritative.' };
}
