import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportHtml } from './reportPdf.js';

function makeSession(overrides = {}) {
	return {
		id: '00000000-0000-4000-8000-000000000000',
		title: 'Example',
		mode: 'qa',
		createdAt: 1735689600000,
		updatedAt: 1735689600000,
		status: 'done',
		targetUrl: 'https://example.com/',
		device: 'iphone-15-pro',
		deviceLandscape: false,
		messages: [],
		activities: [],
		todos: [{ text: 'Open home', status: 'completed' }],
		findings: [
			{ severity: 'high', title: 'Broken CTA', category: 'navigation', url: 'https://example.com/', steps: ['Open home', 'Tap CTA'], expected: 'Signup form opens', actual: '404 page', evidence: 'GET /signup -> 404' },
			{ severity: 'critical', title: 'PII leaked in URL', category: 'security', steps: [], expected: 'Token not in URL', actual: 'Token visible in query' }
		],
		report: { verdict: 'fail', summary: 'Two defects blocked signup.', covered: ['Home', 'Signup'], notCovered: ['Checkout'], recommendations: ['Fix routing'] },
		secretNames: [],
		...overrides
	};
}

test('QA HTML report contains mandatory engineer sections and no marketing text', () => {
	const html = buildReportHtml(makeSession());
	assert.match(html, /<h1>QA report<\/h1>/);
	assert.match(html, /Broken CTA/);
	assert.match(html, /PII leaked/);
	// Critical must be sorted before High
	assert.ok(html.indexOf('PII leaked') < html.indexOf('Broken CTA'), 'critical listed before high');
	assert.match(html, /Device/);
	assert.match(html, /iPhone 15 Pro \(portrait, 393/);
	assert.match(html, /Verdict/);
	assert.doesNotMatch(html, /world-class|revolutionary|cutting[- ]edge/i);
});

test('QA HTML report omits sections with no data', () => {
	const html = buildReportHtml(makeSession({ report: { verdict: 'pass' }, todos: [], findings: [] }));
	assert.doesNotMatch(html, /Recommendations<\/h2>/);
	assert.doesNotMatch(html, /Findings<\/h2>|Findings \(/);
	assert.doesNotMatch(html, /Test plan<\/h2>/);
	assert.doesNotMatch(html, /Covered<\/h2>/);
});

test('SQA HTML report groups results by status and shows scope metadata', () => {
	const session = makeSession({
		mode: 'sqa',
		targetUrl: 'https://staging.example.com/',
		device: 'desktop',
		deviceLandscape: false,
		sqa: {
			scope: {
				target: { name: 'Portal', release: '2026.08.15', environment: 'staging' },
				profiles: ['core'],
				attributes: ['pii'],
				catalogVersion: '2026-08-1',
				scopeNotes: 'Public surfaces only.'
			},
			assessment: {
				assessmentId: 'sqa-assessment-1',
				assessmentSha256: '0123456789abcdef',
				assessedAt: '2026-08-15T12:00:00.000Z',
				catalogVersion: '2026-08-1',
				target: { name: 'Portal', release: '2026.08.15', environment: 'staging' },
				profiles: ['core'],
				attributes: ['pii'],
				verdict: 'fail',
				summary: { applicableControls: 3, pass: 1, fail: 1, blocked: 1, not_assessed: 0 },
				coverage: { observed: 100, conclusive: 66.67, mandatoryPassed: 50, evidence: 75, requiredEvidence: 4, satisfiedEvidence: 3 },
				technicalSummary: { verdict: 'fail', applicableControls: 2, pass: 1, fail: 1, blocked: 0, not_assessed: 0 },
				risk: { level: 'high', score: 61.5, method: 'Severity-weighted unresolved-control score.' },
				gates: [{ status: 'fail', title: 'Mandatory controls', detail: '1/2 mandatory controls passed.' }],
				results: [
					{ controlId: 'C-01', status: 'pass', title: 'Login form validation', domain: 'quality', severity: 'medium', evidenceCoverage: { satisfied: 1, required: 1 } },
					{ controlId: 'C-02', status: 'fail', title: 'CSP misconfigured', domain: 'security', severity: 'high', automationLevel: 'automated', rationale: 'No frame-ancestors', decisionNotes: ['Header was absent.'], evidenceCoverage: { satisfied: 1, required: 1, requirements: [{ type: 'security_report', description: 'Security header evidence', minimum: 1, actual: 1, satisfied: true }] }, evidence: [{ type: 'security_report', summary: 'Response header capture', reference: 'qase://evidence/csp', digest: 'sha256:abc' }] },
					{ controlId: 'C-03', status: 'blocked', title: 'DPA absent', domain: 'privacy', severity: 'high', automationLevel: 'manual', rationale: 'Reviewer artifact was unavailable.', decisionNotes: ['Approval evidence is required.'], evidenceCoverage: { satisfied: 0, required: 1, requirements: [{ type: 'approval_record', description: 'Approved DPA', minimum: 1, actual: 0, satisfied: false }] }, evidence: [] }
				],
				frameworkCoverage: [{ title: 'ISO/IEC 25010', url: 'https://example.com/iso', controls: 2, status: 'fail', coverage: 50 }],
				outOfScope: [{ controlId: 'C-99', reason: 'No payment workflow declared.' }],
				disclaimer: 'Engineering assurance only; not certification.'
			}
		}
	});
	const html = buildReportHtml(session);
	assert.match(html, /SQA assessment/);
	assert.match(html, /FAIL/);
	assert.match(html, /Scope notes/);
	assert.match(html, /sqa-assessment-1/);
	assert.match(html, /sha256:0123456789abcdef/);
	assert.match(html, /Assessment outcome/);
	assert.match(html, /Coverage & evidence completeness/);
	assert.match(html, /Bounded technical smoke sample/);
	assert.match(html, /Decision gates/);
	assert.match(html, /Unresolved controls/);
	assert.match(html, /Referenced evidence/);
	assert.match(html, /qase:\/\/evidence\/csp/);
	assert.match(html, /Framework crosswalk/);
	assert.match(html, /ISO\/IEC 25010/);
	assert.match(html, /Not applicable in the declared scope/);
	assert.match(html, /Assessment boundary/);
	assert.match(html, /C-02/);
	// The summary table is risk-first: failed and blocked controls precede passes.
	assert.ok(html.indexOf('C-02') < html.indexOf('C-01'), 'failed control listed before pass');
});

test('Founder HTML report renders the complete structured professional brief', () => {
	const session = makeSession({
		mode: 'founder',
		founder: {
			scope: {
				target: { name: 'Acme AI', url: 'https://example.com/' },
				productContext: { stage: 'seed', businessModel: 'SaaS', targetCustomer: 'ops teams', primaryGoal: 'convert trials' }
			},
			observations: [{
				id: 'F-01', category: 'onboarding', type: 'friction', title: 'Signup requires phone',
				summary: 'Blocks demo path', confidence: 'high',
				evidence: [{ summary: 'Observed required phone field', reference: 'qase://runs/1/activities/a1', digest: 'sha256:def' }]
			}],
				report: {
				schemaVersion: '2026.08.1',
				generatedAt: '2026-08-20T12:00:00.000Z',
				target: { name: 'Acme AI', url: 'https://example.com/', release: '1.0.0', environment: 'production' },
				executiveSummary: 'Reduce onboarding friction and clarify the commercial path.',
				coverage: { categoriesReviewed: ['onboarding', 'monetization_pricing'], totalCategories: 17, evidenceBackedObservations: 1 },
				evidenceConfidence: { rating: 'medium', uniqueBrowserActivities: 1, assumptionCount: 2, limitation: 'Browser-accessible evidence only.' },
				icp: { primary: 'Operations leaders', users: ['Operators'], buyers: ['VP Operations'], jobs: ['Ship reliable work'], pains: ['Slow setup'], evidenceObservationIds: ['F-01'], assumptions: ['Buyer role needs validation.'] },
				positioning: { category: 'Operations platform', oneLiner: 'Move work faster.', valueProposition: 'A focused workspace.', differentiators: ['Fast setup'], alternatives: ['Spreadsheets'], evidenceObservationIds: ['F-01'], assumptions: [] },
				monetization: { model: 'Subscription', valueMetric: 'Active workspace', pricingPresentation: 'Publish transparent tiers.', packages: ['Starter', 'Growth'], nextTests: ['Interview five buyers'], evidenceObservationIds: [], assumptions: ['Willingness to pay is unknown.'] },
				recommendations: [
					{ id: 'rec-1', category: 'onboarding', title: 'Remove phone from signup', rationale: 'Cited by F-01', actions: ['Make phone optional'], impact: 'high', effort: 'low', confidence: 'medium', evidenceObservationIds: ['F-01'], assumptions: [] }
				],
				quickWins: ['rec-1'],
				marketing: { channels: [{ channel: 'Founder-led content', rationale: 'Demonstrate the workflow.', firstTest: 'Publish three teardown posts.', confidence: 'medium', evidenceObservationIds: ['F-01'], assumptions: [] }], contentAngles: ['Before-and-after workflow'], launchMotions: ['Design partner launch'], growthLoops: ['Shareable output'], assumptions: ['Audience reach is unknown.'] },
				sales: { motion: 'Founder-led discovery', qualificationQuestions: ['How is this solved today?'], objectionResponses: [{ objection: 'Switching cost', response: 'Start with one workflow.' }], salesAssets: ['ROI worksheet'], evidenceObservationIds: ['F-01'], assumptions: [] },
				risks: [{ title: 'Activation friction', likelihood: 'high', impact: 'high', mitigation: 'Shorten setup.', evidenceObservationIds: ['F-01'], assumptions: [] }],
				plan: { days30: ['Fix signup'], days60: ['Validate pricing'], days90: ['Scale the winning channel'] },
				metrics: {
					northStar: { name: 'Activated workspaces', definition: 'Workspaces completing the core outcome.', why: 'Measures delivered value.', evidenceObservationIds: ['F-01'], assumptions: [] },
					candidates: [{ name: 'Time to value', definition: 'Minutes to first outcome.', evidenceObservationIds: ['F-01'], assumptions: [] }],
					experiments: [{ hypothesis: 'Optional phone increases completion.', change: 'Remove required phone.', successMetric: 'Signup completion', timebox: 'Two weeks', guardrail: 'Qualified activation rate', evidenceObservationIds: ['F-01'], assumptions: [] }]
				},
				caveat: 'Evidence-informed guidance, not guaranteed outcomes.'
			}
		}
	});
	const html = buildReportHtml(session);
	assert.match(html, /Founder review/);
	assert.match(html, /Context<\/h2>/);
	assert.match(html, /2026\.08\.1/);
	assert.match(html, /2026-08-20T12:00:00\.000Z/);
	assert.match(html, /Executive summary/);
	assert.match(html, /Evidence confidence/);
	assert.match(html, /Observation evidence registry/);
	assert.match(html, /F-01/);
	assert.match(html, /Ideal customer profile/);
	assert.match(html, /Positioning/);
	assert.match(html, /Monetization & pricing/);
	assert.match(html, /Prioritized recommendations<\/h2>/);
	assert.match(html, /Quick wins/);
	assert.match(html, /Marketing & growth/);
	assert.match(html, /Sales & go-to-market/);
	assert.match(html, /30 \/ 60 \/ 90-day plan/);
	assert.match(html, /Metrics & experiments/);
	assert.match(html, /Important boundary/);
	assert.match(html, /Impact high/);
	assert.doesNotMatch(html, /undefined/);
});

test('HTML report escapes user-supplied content to prevent injection', () => {
	const html = buildReportHtml(makeSession({
		targetUrl: '<script>alert(1)</script>',
		findings: [{ severity: 'critical', title: '</h1><img onerror=x>', category: 'x', steps: ['a'] }]
	}));
	assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
	assert.match(html, /&lt;script&gt;/);
	assert.match(html, /&lt;\/h1&gt;/);
});

test('Device line reflects landscape orientation swap', () => {
	const html = buildReportHtml(makeSession({ device: 'ipad-pro-11', deviceLandscape: true }));
	assert.match(html, /iPad Pro 11(&quot;|").*landscape, 1194/);
});
