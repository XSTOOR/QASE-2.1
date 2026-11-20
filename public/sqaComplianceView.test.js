import test from 'node:test';
import assert from 'node:assert/strict';
import { complianceBadge, complianceCounts, isSqaComplianceRun, renderComplianceView, renderSqaReportCard } from './sqaComplianceView.js';
import { isQaConversationMessage, renderQaMessageBody } from './qaConversation.js';

function fakeDocument() {
	const make = tag => ({
		tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, listeners: {}, style: {}, className: '', textContent: '', innerHTML: '',
		append(...items) { this.children.push(...items.map(item => typeof item === 'string' ? { textContent: item, children: [] } : item)); },
		setAttribute(name, value) { this.attributes[name] = value; },
		addEventListener(type, listener) { this.listeners[type] = listener; }
	});
	return { createElement: make };
}
const text = node => [node.textContent, ...(node.children ?? []).map(text)].filter(Boolean).join(' ');
const findAll = (node, predicate, out = []) => { if (predicate(node)) out.push(node); for (const child of node.children ?? []) findAll(child, predicate, out); return out; };

const session = {
	id: 'run-sqa', mode: 'sqa', status: 'done', targetUrl: 'https://brightpath.test/',
	findings: [{ id: 'f1', requirementId: 'R2', title: 'COPPA: notice', severity: 'high' }],
	sqa: {
		version: 3, phases: { open: { status: 'done', detail: '6 pages' }, identify: { status: 'done' }, research: { status: 'done' }, test: { status: 'running' } },
		product: { name: 'BrightPath', category: 'education', subcategory: 'K-12 tutoring', summary: 'Online courses for children.', audience: { description: 'Parents and pupils', children: true, students: true }, regions: ['United States'], dataHandled: ['children', 'accounts'], features: ['sign-up'], evidence: ['/: hero says ages 8-14'] },
		frameworks: [
			{ id: 'F1', name: 'COPPA', mandatory: true, url: 'https://www.ftc.gov/coppa', applicability: 'Directed at children under 13.' },
			{ id: 'F2', name: 'WCAG 2.2 AA', mandatory: false, url: 'javascript:alert(1)', applicability: 'Accessibility baseline.' }
		],
		requirements: [
			{ id: 'R1', frameworkId: 'F1', clause: '312.5', title: 'Parental consent', check: 'Consent before collection', method: 'browser', severity: 'critical', status: 'pass', decidedBy: 'agent', url: 'https://brightpath.test/signup' },
			{ id: 'R2', frameworkId: 'F1', clause: '312.4', title: 'Children notice', check: 'Policy covers children', method: 'browser', severity: 'high', status: 'fail', observed: 'No children section', fix: 'Add a section', decidedBy: 'agent', evidenceIds: ['E1'] },
			{ id: 'R3', frameworkId: 'F2', clause: '1.1.1', title: 'Alt text', check: 'Images have alt', method: 'automated', severity: 'medium', status: 'untested' }
		],
		evidence: [{ id: 'E1', kind: 'privacy.children', title: 'Children cues', status: 'issue', detail: 'Ages 8-14 but no policy section', artifactId: 'A1' }],
		sources: [{ url: 'https://www.ftc.gov/coppa', title: 'COPPA rule', via: 'fetch' }],
		limitations: [{ message: 'Signed-in pages were not tested.' }]
	},
	report: { verdict: 'non_compliant', summary: 'Serious COPPA gap.', priorities: ['Add a children section'], frameworks: [{ id: 'F1', name: 'COPPA', score: 50, total: 2, pass: 1, fail: 1, partial: 0 }, { id: 'F2', name: 'WCAG 2.2 AA', score: null, total: 1 }], counts: { pass: 1, fail: 1, partial: 0, needs_documents: 0 } }
};

test('only version 3 compliance runs use the new view', () => {
	assert.equal(isSqaComplianceRun(session), true);
	assert.equal(isSqaComplianceRun({ mode: 'sqa', sqa: { scope: {} } }), false);
	assert.equal(isSqaComplianceRun({ mode: 'qa' }), false);
});

test('counts and badge follow the requirement results and the verdict', () => {
	assert.deepEqual(complianceCounts(session.sqa), { total: 3, pass: 1, fail: 1, partial: 0, needsDocuments: 0, notApplicable: 0, untested: 1 });
	assert.equal(complianceBadge(session), '1');
	assert.equal(complianceBadge({ ...session, sqa: { ...session.sqa, requirements: [] }, report: { verdict: 'no_gaps_found' } }), '✓');
});

test('the compliance view shows product, standards, requirements, evidence and sources', () => {
	const doc = fakeDocument();
	const view = renderComplianceView(session, { artifactUrl: id => `https://qase.test/api/artifacts/${id}`, findingFor: id => session.findings.find(f => f.requirementId === id), onOpenFinding() {} }, doc);
	const all = text(view);
	for (const expected of ['BrightPath', 'Education / e-learning', 'K-12 tutoring', "Children's data", 'COPPA', 'Legally required', 'Recommended', '50%', 'Children notice', 'No children section', 'Add a section', 'Children cues', 'COPPA rule', 'Signed-in pages were not tested.', 'Not tested'])
		assert.ok(all.includes(expected), `missing ${expected}`);
	const links = findAll(view, item => item.tagName === 'A');
	assert.ok(links.every(item => /^https:/.test(item.href)), 'only http(s) links are rendered');
	assert.ok(!links.some(item => String(item.href).startsWith('javascript')));
	const order = findAll(view, item => item.dataset?.requirement).map(item => item.dataset.requirement);
	assert.deepEqual(order.slice(0, 2), ['R2', 'R1'], 'gaps are listed before passes');
	assert.equal(findAll(view, item => item.dataset?.stage).length, 0, 'a finished report leads with results, not progress');
	const live = renderComplianceView({ ...session, status: 'running', report: undefined }, {}, fakeDocument());
	assert.equal(findAll(live, item => item.dataset?.stage === 'test' && /is-running/.test(item.className)).length, 1);
});

test('older SQA runs get a read-only notice instead of the compliance view', () => {
	const view = renderComplianceView({ mode: 'sqa', sqa: { scope: {} }, findings: [{}] }, {}, fakeDocument());
	assert.match(text(view), /previous quality-review workflow/);
});

test('the compliance report message renders as a report card in the conversation', () => {
	const message = { role: 'agent', kind: 'sqa-report', id: 'sqa-report-1', text: 'Serious COPPA gap.' };
	assert.equal(isQaConversationMessage(message, session), true);
	assert.equal(isQaConversationMessage(message, { mode: 'sqa', sqa: {} }), false, 'old SQA transcripts render as plain messages');
	const card = renderQaMessageBody(message, session, { onOpenReport() {}, onDownloadPdf() {}, onCopyAll() {} }, { doc: fakeDocument() });
	const all = text(card);
	assert.match(all, /Compliance test complete/);
	assert.match(all, /Serious gaps/);
	assert.match(all, /COPPA 50%/);
	assert.match(all, /not scored/);
	assert.match(all, /Copy all fix prompts/);
	assert.ok(renderSqaReportCard(session, message, {}, fakeDocument()));
});
