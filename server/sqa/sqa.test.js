import test from 'node:test';
import assert from 'node:assert/strict';
import { baselineFrameworks, baselineRequirements, fallbackRequirementsFor } from './catalog.js';
import { createSqaRunState, heuristicProduct, isSqaEngineSession, SQA_ENGINE_VERSION } from './engine.js';
import { buildSqaReport, frameworkScores, requirementFindings, verdictFor } from './report.js';
import { defineRequirementsTool, finishTool, recordProductTool, recordResultTool, selectFrameworksTool } from './tools.js';
import { sqaModelSettings } from './agent.js';

const fresh = () => createSqaRunState({ focus: '  Courses for kids  ', regions: 'India' });

test('run state is versioned and keeps the owner hints', () => {
	const state = fresh();
	assert.equal(state.version, SQA_ENGINE_VERSION);
	assert.deepEqual(state.scope, { profiles: ['compliance'] }, 'the run store schema needs one profile identifier');
	assert.equal(state.focus, 'Courses for kids');
	assert.equal(state.regionsHint, 'India');
	assert.equal(isSqaEngineSession({ mode: 'sqa', sqa: state }), true);
	assert.equal(isSqaEngineSession({ mode: 'sqa', sqa: { scope: {} } }), false, 'runs of the retired workflow are not engine runs');
	assert.equal(createSqaRunState({}).focus, undefined);
});

test('the product profile needs a known category and cited evidence', async () => {
	const state = fresh();
	const record = recordProductTool(state);
	assert.equal((await record.run({ name: 'X', category: 'spaceships', summary: 's', audience: { description: 'd' }, evidence: ['/'] })).success, false);
	assert.equal((await record.run({ name: 'X', category: 'education', summary: 's', audience: { description: 'd' }, evidence: [] })).success, false);
	const ok = await record.run({ name: 'Bright', category: 'education', summary: 'Courses', audience: { description: 'Kids', children: true }, data_handled: ['children', 'invented'], evidence: ['/: ages 8-14'] });
	assert.equal(ok.success, true);
	assert.deepEqual(state.product.dataHandled, ['children'], 'unknown data types are dropped');
	assert.equal(state.product.audience.children, true);
});

test('a framework is accepted only with a source found in the research', async () => {
	const state = fresh();
	state.sources.push({ url: 'https://www.ftc.gov/coppa', title: 'COPPA' });
	const select = selectFrameworksTool(state);
	const result = await select.run({ frameworks: [
		{ name: 'COPPA', source_url: 'https://www.ftc.gov/legal-library/coppa', applicability: 'children', mandatory: true },
		{ name: 'Invented', source_url: 'https://invented.example/', applicability: 'none', mandatory: false },
		{ name: 'Bad URL', source_url: 'javascript:alert(1)', applicability: 'x', mandatory: false }
	] });
	assert.equal(result.success, true);
	assert.deepEqual(state.frameworks.map(item => item.name), ['COPPA'], 'same host as a researched source is accepted; others are rejected');
	assert.equal(result.rejected.length, 2);
	assert.equal((await selectFrameworksTool(fresh()).run({ frameworks: [{ name: 'A', source_url: 'https://a.example/', applicability: 'x', mandatory: true }] })).success, false);
});

test('requirements are numbered per run, and automated ones need measurable evidence', async () => {
	const state = fresh();
	state.frameworks = [{ id: 'F1', name: 'WCAG' }, { id: 'F2', name: 'COPPA' }];
	const define = defineRequirementsTool(state);
	assert.equal((await define.run({ framework_id: 'F9', requirements: [] })).success, false);
	await define.run({ framework_id: 'F1', requirements: [
		{ clause: '1.1.1', title: 'Alt text', check: 'Images have alt', method: 'automated', evidence_kinds: ['a11y.images_alt'], severity: 'high' },
		{ clause: '2.4.7', title: 'Focus', check: 'Focus visible', method: 'automated', evidence_kinds: ['not.a.kind'], severity: 'extreme' }
	] });
	await define.run({ framework_id: 'F2', requirements: [{ clause: '312.5', title: 'Consent', check: 'Parental consent records', method: 'document', severity: 'high' }] });
	assert.deepEqual(state.requirements.map(item => item.id), ['R1', 'R2', 'R3']);
	assert.equal(state.requirements[1].method, 'browser', 'automated without a known evidence kind becomes a browser check');
	assert.equal(state.requirements[1].severity, 'medium');
	assert.ok(state.requirements.every(item => item.status === 'untested'));
	await define.run({ framework_id: 'F1', requirements: [{ clause: '1.4.3', title: 'Contrast', check: 'Contrast 4.5:1', method: 'browser', severity: 'medium' }] });
	assert.deepEqual(state.requirements.map(item => item.title), ['Consent', 'Contrast'], 'redefining a framework replaces its requirements');
});

test('results need evidence for a pass and a fix for a gap', async () => {
	const state = fresh();
	state.requirements = [{ id: 'R1', status: 'untested' }, { id: 'R2', status: 'untested' }];
	state.evidence = [{ id: 'E1' }];
	const record = recordResultTool(state);
	assert.equal((await record.run({ requirement_id: 'R1', status: 'pass', observed: 'ok' })).success, false, 'a pass with no evidence or page is refused');
	assert.equal((await record.run({ requirement_id: 'R1', status: 'fail', observed: 'missing' })).success, false, 'a fail needs a fix');
	assert.equal((await record.run({ requirement_id: 'R1', status: 'maybe', observed: 'x' })).success, false);
	const passed = await record.run({ requirement_id: 'R1', status: 'pass', observed: 'ok', evidence_ids: ['E1', 'E99'] });
	assert.equal(passed.success, true);
	assert.deepEqual(state.requirements[0].evidenceIds, ['E1'], 'unknown evidence ids are dropped');
	assert.deepEqual(passed.remaining, ['R2']);
	assert.equal((await finishTool(state).run({ summary: '' })).success, false);
	assert.equal((await finishTool(state).run({ summary: 'Done.', priorities: ['Fix R2'] })).success, true);
});

test('scores and the verdict are computed from the results, not by the model', () => {
	const state = { ...fresh(), frameworks: [{ id: 'F1', name: 'COPPA', mandatory: true }, { id: 'F2', name: 'WCAG', mandatory: false }],
		requirements: [
			{ id: 'R1', frameworkId: 'F1', status: 'pass', severity: 'high' },
			{ id: 'R2', frameworkId: 'F1', status: 'partial', severity: 'high' },
			{ id: 'R3', frameworkId: 'F2', status: 'fail', severity: 'critical', title: 'Alt', clause: '1.1.1', check: 'alt', fix: 'Add alt', observed: 'none' },
			{ id: 'R4', frameworkId: 'F2', status: 'needs_documents', severity: 'low' }
		] };
	const [coppa, wcag] = frameworkScores(state);
	assert.equal(coppa.score, 75);
	assert.equal(wcag.score, 0);
	assert.equal(wcag.needsDocuments, 1);
	assert.equal(verdictFor(state), 'gaps_found', 'a critical fail in a recommended standard is a gap, not non-compliance');
	state.requirements[1].status = 'fail';
	assert.equal(verdictFor(state), 'non_compliant', 'a high-impact fail in a mandatory standard');
	assert.equal(verdictFor({ ...state, requirements: state.requirements.map(item => ({ ...item, status: 'needs_documents' })) }), 'not_assessed');
	state.requirements = state.requirements.map(item => ({ ...item, status: 'pass' }));
	assert.equal(verdictFor(state), 'no_gaps_found');
});

test('the report and findings carry the gaps, fixes and the disclaimer', () => {
	const sqa = { ...fresh(), product: { name: 'Bright' }, frameworks: [{ id: 'F1', name: 'COPPA', mandatory: true, url: 'https://www.ftc.gov/coppa' }],
		requirements: [{ id: 'R1', frameworkId: 'F1', clause: '312.4', title: 'Notice', check: 'Policy covers children', status: 'fail', severity: 'high', observed: 'No section', fix: 'Add one', evidenceIds: ['E1'] }],
		evidence: [{ id: 'E1', title: 'Children cues', detail: 'Ages 8-14', urls: ['https://b.test/'], artifactId: 'A1' }],
		limitations: [{ message: 'Signed-in pages were not tested.' }] };
	const session = { targetUrl: 'https://b.test/', sqa };
	const report = buildSqaReport(session);
	assert.equal(report.verdict, 'non_compliant');
	assert.match(report.summary, /Bright[\s\S]*1 failed/);
	assert.deepEqual(report.notCovered, ['Signed-in pages were not tested.']);
	assert.match(report.disclaimer, /not legal advice/);
	const [finding] = requirementFindings(session);
	assert.equal(finding.category, 'compliance');
	assert.equal(finding.requirementId, 'R1');
	assert.equal(finding.fix, 'Add one');
	assert.equal(finding.artifactId, 'A1');
	assert.match(finding.title, /^COPPA 312\.4: Notice/);
});

test('baselines follow the product: children, regions, payments', () => {
	const kids = baselineFrameworks({ category: 'education', audience: { children: true }, regions: ['India', 'United States'], dataHandled: ['payments'] });
	const names = kids.map(item => item.id);
	for (const id of ['F-wcag', 'F-owasp', 'F-dpdp', 'F-ccpa', 'F-coppa', 'F-ferpa', 'F-pci']) assert.ok(names.includes(id), id);
	assert.ok(!names.includes('F-gdpr'), 'GDPR is only the default when no region is known');
	assert.ok(kids.every(item => item.baseline));
	assert.ok(baselineFrameworks({}).some(item => item.id === 'F-gdpr'));
	assert.ok(baselineRequirements(kids).every(item => item.method === 'automated' && item.evidenceKinds.length));
	assert.ok(fallbackRequirementsFor({ id: 'F7', name: 'Section 508', kind: 'accessibility' }).every(item => item.frameworkId === 'F7'));
	assert.deepEqual(fallbackRequirementsFor({ id: 'F8', name: 'Tax code', kind: 'other' }), []);
});

test('without a model the product is identified from page keywords', () => {
	const product = heuristicProduct([{ title: 'BrightPath | Learn', text: 'Online courses for kids. Our students and teachers love each lesson. Fees in ₹.', url: 'https://b.in/' }], 'https://b.in/');
	assert.equal(product.category, 'education');
	assert.equal(product.audience.children, true);
	assert.deepEqual(product.regions, ['India']);
	assert.equal(product.heuristic, true);
	assert.equal(heuristicProduct([{ title: 'Hi', text: 'hello', url: 'https://x.test/' }], 'https://x.test/').category, 'other');
});

test('model settings: reasoning model only, and a SearXNG base URL', () => {
	const settings = { reasoner: { model: 'claude', baseUrl: 'https://llm.test/v1', apiKey: 'k', enabled: true }, jev: { model: 'jev', enabled: true } };
	const model = sqaModelSettings(settings, { QASE_SQA_SEARCH_URL: 'https://searx.test/search/' });
	assert.equal(model.model, 'claude');
	assert.equal(model.searchUrl, 'https://searx.test', 'an older /search URL is accepted');
	assert.equal(sqaModelSettings(settings, {}).searchUrl, undefined);
	assert.equal(sqaModelSettings(settings, { QASE_SQA_MAX_TURNS: '9999' }).maxTurns, 200);
	assert.ok(!JSON.stringify(model).includes('jev'), 'JEV is never part of compliance testing');
});
