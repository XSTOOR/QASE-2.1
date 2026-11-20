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

test('SQA HTML report shows the product, each standard with its score, the gaps and the disclaimer', async () => {
	const { createSqaRunState } = await import('./sqa/engine.js');
	const { buildSqaReport } = await import('./sqa/report.js');
	const sqa = Object.assign(createSqaRunState({}), {
		product: { name: 'Portal Kids', category: 'education', summary: 'Courses for children.', audience: { description: 'Pupils', children: true }, regions: ['United States'], dataHandled: ['children'] },
		frameworks: [{ id: 'F1', name: 'COPPA', url: 'https://www.ftc.gov/coppa', applicability: 'Directed at children.', mandatory: true }],
		requirements: [
			{ id: 'R1', frameworkId: 'F1', clause: '312.4', title: 'Notice <covers> children', check: 'Policy covers children', method: 'browser', severity: 'high', status: 'fail', observed: 'No section', fix: 'Add a section' },
			{ id: 'R2', frameworkId: 'F1', clause: '312.5', title: 'Parental consent records', check: 'Consent records kept', method: 'document', severity: 'high', status: 'needs_documents' }
		],
		evidence: [], sources: [{ url: 'https://www.ftc.gov/coppa', title: 'COPPA rule' }], limitations: []
	});
	const session = makeSession({ mode: 'sqa', findings: [], sqa });
	session.report = buildSqaReport(session);
	const html = buildReportHtml(session);
	for (const expected of [/Portal Kids/, /COPPA/, /0%/, /312\.4/, /Add a section/, /Needs documents/, /not legal advice/]) assert.match(html, expected);
	assert.match(html, /Notice &lt;covers&gt; children/, 'model and page text is escaped');
	assert.doesNotMatch(html, /<covers>/);
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

test('#16654 Founder HTML report embeds the user feedback section', () => {
	// Minimal-but-valid founder session reusing the founder fixture shape.
	const founderSession = makeSession({
		mode: 'founder',
		founder: {
			scope: { target: { name: 'Acme AI', url: 'https://example.com/' } },
			report: { executiveSummary: 'Reduce friction.', caveat: 'Evidence-informed guidance.' },
			finalizedAt: '2026-10-17T00:00:00.000Z'
		},
		userFeedback: {
			rating: 4,
			comments: 'Founder review flow was thorough',
			improvement: 'Add competitor comparison',
			userName: 'Manoj Kumar',
			submittedAtFormatted: '17-Oct-2026 10:30 AM IST'
		}
	});
	const html = buildReportHtml(founderSession);
	assert.match(html, /User feedback<\/h2>/);
	assert.match(html, /Founder review flow was thorough/);
	assert.match(html, /Add competitor comparison/);
	assert.match(html, /Manoj Kumar/);
	assert.match(html, /17-Oct-2026 10:30 AM IST/);
});

test('#16654 Founder HTML report omits the feedback section cleanly when absent', () => {
	const founderSession = makeSession({
		mode: 'founder',
		founder: {
			scope: { target: { name: 'Acme AI', url: 'https://example.com/' } },
			report: { executiveSummary: 'Reduce friction.' },
			finalizedAt: '2026-10-17T00:00:00.000Z'
		}
	});
	const html = buildReportHtml(founderSession);
	assert.doesNotMatch(html, /User feedback<\/h2>/);
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

test('Environment snapshot replaces the device line and labels the provider', () => {
	const snapshot = {
		envId: 'ENV-IOS-IP15PRO-18.3-SAF-18.3',
		platform: 'ios',
		device: 'iPhone 15 Pro',
		osVersion: '18.3',
		browser: 'Safari',
		browserVersion: '18.3',
		executionProvider: 'environment'
	};
	const html = buildReportHtml(makeSession({ environmentSnapshot: snapshot }));
	assert.match(html, /iPhone 15 Pro &#183;|iPhone 15 Pro \u00b7/);
	// Phase 22: a catalog hint alone never claims "real device" — no recorded
	// level means the honest NOT AVAILABLE FOR REAL EXECUTION label.
	assert.doesNotMatch(html, /BrowserStack real device/);
	assert.match(html, /NOT AVAILABLE FOR REAL EXECUTION/);
	assert.doesNotMatch(html, /portrait, 393/);
});

test('PDF labels REAL DEVICE only from recorded runtime facts', () => {
	const html = buildReportHtml(makeSession({
		environmentSnapshot: { envId: 'ENV-R', device: 'Pixel 9', osVersion: '15', browser: 'Chrome', browserVersion: '140' },
		runtimeFacts: { executionLevel: 'REAL_DEVICE', provider: 'browserstack' }
	}));
	assert.match(html, /REAL DEVICE \(remote environment runtime\)/);

	const simHtml = buildReportHtml(makeSession({
		environmentSnapshot: { envId: 'ENV-S', device: 'Pixel 9', osVersion: '15', browser: 'Chrome', browserVersion: '140' },
		executionLevelRequested: 'REAL_DEVICE',
		runtimeFacts: { executionLevel: 'SIMULATED', provider: 'local-simulation' }
	}));
	assert.match(simHtml, /SIMULATED \(local-simulation\)/);
	assert.doesNotMatch(simHtml, /REAL DEVICE/);
});
