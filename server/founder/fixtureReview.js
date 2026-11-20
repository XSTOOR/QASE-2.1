/**
 * A finished Founder review built through the real recording tools and report
 * builder, without a browser or a model. Used by view tests and browser tests
 * that need a published review to render.
 */
import { randomUUID } from 'node:crypto';
import { createFounderRunState } from './engine.js';
import { toSignals } from './signals.js';
import { recordBusinessTool, recordMarketTool, recordJourneyTool, scoreLensTool, recordRecommendationsTool, finishTool } from './tools.js';
import { buildFounderReport, founderFindings } from './report.js';
import { LENS_IDS } from './catalog.js';

const TARGET = 'https://taskly.test/';

async function call(tool, input) {
	const result = await tool.run(input);
	if (!result.success) throw new Error(`${tool.name}: ${result.error}`);
	return result;
}

/** Facts in the shape collectSignals measures; several gaps are planted. */
export const FIXTURE_FACTS = {
	desktop: {
		fold: 900,
		headline: { text: 'The flexible platform that empowers modern teams to achieve more every single day', words: 14, aboveFold: true },
		ctas: [{ label: 'Pricing', top: 20, action: true, inNav: true }, { label: 'Start free trial', top: 2700, action: true, inNav: false }],
		meta: { title: 'Taskly', description: '', ogTitle: '', ogImage: '' }
	},
	mobile: { fold: 844, overflow: 900, ctas: [{ label: 'Start free trial', top: 3100, action: true }] },
	pages: [
		{ url: TARGET, socialProof: 0, about: true, contact: true, privacy: true, terms: true, prices: 0, pricingLink: `${TARGET}pricing`, freeStart: false, hooks: [] },
		{ url: `${TARGET}signup`, forms: [{ fields: 9, required: 9, names: ['name', 'email', 'password', 'company', 'role', 'size', 'phone', 'country', 'source'], signup: true }] }
	],
	broken: [{ href: `${TARGET}pricing`, status: 404 }],
	visual: [], readability: [{ title: 'Low-contrast footer text' }], mobileIssues: [],
	metrics: { lcpMs: 1800 }, errors: [], failed: []
};

export async function createFounderReviewFixture({ name = 'Taskly', brief = { goals: 'More trial sign-ups', audience: 'Small agencies', stage: 'early', journeys: 'Start a free trial' } } = {}) {
	const now = Date.now();
	const state = createFounderRunState({ targetUrl: TARGET, name, brief });
	state.targetUrl = TARGET;
	const signals = toSignals(FIXTURE_FACTS, { targetUrl: TARGET });
	state.signals = signals;
	state.sources = [
		{ url: 'https://asana.test/', title: 'Asana', via: 'web_search' },
		{ url: 'https://trello.test/', title: 'Trello', via: 'web_search' }
	];
	const gap = signals.find(item => item.status !== 'good')?.id ?? signals[0].id;

	await call(recordBusinessTool(state), {
		name, category: Object.keys((await import('./catalog.js')).PRODUCT_CATEGORIES)[0], one_liner: 'Task management for small agencies.',
		value_proposition: FIXTURE_FACTS.desktop.headline.text, target_customer: { stated: '', inferred: 'Agencies with 5–20 people' },
		business_model: 'free_trial', primary_goal: 'sign_up', stage: 'early',
		journeys: [{ name: 'Compare pricing', goal: 'Find out what it costs' }, { name: 'Understand the product', goal: 'Know what it does in 10 seconds' }],
		evidence: ['/: hero headline does not say who it is for']
	});
	await call(recordMarketTool(state), {
		competitors: [
			{ name: 'Asana', url: 'https://asana.test/', positioning: 'Work management for teams', pricing: 'Free plan; paid from $10.99', strengths: ['Templates', 'Free plan'], source_url: 'https://asana.test/' },
			{ name: 'Trello', url: 'https://trello.test/', positioning: 'Visual boards', pricing: 'Free plan', strengths: ['Fast start'], source_url: 'https://trello.test/' }
		],
		expectations: ['A free plan or trial without a card', 'Visible pricing'], differentiation: ['Built for agencies: client portals']
	});
	const [j1, j2, j3] = state.journeyPlan;
	await call(recordJourneyTool(state), { journey_id: j1.id, outcome: 'partial', steps: ['Opened the home page', 'Scrolled to find the sign-up button', 'Opened a 9-field form'], friction: [{ issue: 'Nine required fields before trying the product', severity: 'high', page: '/signup', impact: 'Trial drop-off' }], delights: ['Clean layout'], summary: 'Sign-up works but asks too much.' });
	await call(recordJourneyTool(state), { journey_id: j2.id, outcome: 'blocked', steps: ['Clicked Pricing', 'Got a 404 page'], friction: [{ issue: 'Pricing page is missing', severity: 'critical', page: '/pricing', impact: 'Buyers leave to compare elsewhere' }], summary: 'Pricing cannot be found.' });
	if (j3) await call(recordJourneyTool(state), { journey_id: j3.id, outcome: 'completed', steps: ['Read the features page'], summary: 'Features are listed clearly.' });

	const scores = { value_prop: 4, trust: 4, onboarding: 3, conversion: 2, experience: 6, mobile: 4, performance: 5, discoverability: 4, retention: 5, positioning: 4 };
	for (const lens of LENS_IDS) await call(scoreLensTool(state), { lens, score: scores[lens] ?? 5, verdict: `${lens.replace('_', ' ')} needs work before scaling.`, strengths: ['Clean visual design'], weaknesses: ['Not specific to agencies'], evidence: [gap, j1.id] });

	await call(recordRecommendationsTool(state), {
		recommendations: [
			{ title: 'Publish a pricing page with a free trial', lens: 'conversion', kind: 'do', priority: 'now', impact: 'high', effort: 'small', why: 'Buyers who cannot see a price leave to Asana and Trello, which both show a free plan.', how: ['Create /pricing with 2–3 plans', 'Link it from the header'], metric: 'Visitor-to-trial rate', acceptance: ['/pricing returns 200 and shows prices'], evidence: [j2.id, 'C1'] },
			{ title: 'Replace the hero headline with the outcome agencies get', lens: 'value_prop', kind: 'do', priority: 'now', impact: 'high', effort: 'small', why: 'Visitors cannot tell who it is for in five seconds.', how: ['Name the customer and the outcome in the H1', 'Keep it under 10 words'], metric: 'Bounce rate', acceptance: ['The H1 names agencies'], evidence: [gap] },
			{ title: 'Cut the sign-up form to email and password', lens: 'onboarding', kind: 'do', priority: 'next', impact: 'high', effort: 'small', why: 'Nine required fields lose trial users.', how: ['Ask only for email and password', 'Collect the rest after the first project'], metric: 'Sign-up completion', acceptance: ['Form has at most 2 required fields'], evidence: [j1.id] },
			{ title: 'Do not launch paid ads before the pricing page exists', lens: 'positioning', kind: 'avoid', priority: 'now', impact: 'medium', effort: 'small', why: 'Paid traffic would land on the same dead end.', how: ['Hold ad spend until pricing and the headline are fixed'], evidence: [j2.id] },
			{ title: 'Add customer logos and one agency case study', lens: 'trust', kind: 'do', priority: 'later', impact: 'medium', effort: 'medium', why: 'There is no social proof on the page.', how: ['Ask three customers for a quote'], evidence: [gap] }
		],
		keep: [{ title: 'Clean, uncluttered layout', why: 'It already feels professional.', evidence: [j3?.id ?? j1.id] }]
	});
	await call(finishTool(state), {
		summary: `${name} looks professional but does not yet convert: pricing is missing, the headline is vague and sign-up asks too much. Fix those three before spending on growth.`,
		positioning: `${name} helps small agencies run client projects in one place, unlike general-purpose boards.`,
		headline_options: ['Client projects, delivered on time', 'Run your agency in one place']
	});

	const id = randomUUID();
	const session = {
		id, mode: 'founder', status: 'done', title: `Founder — ${name}`, targetUrl: TARGET, createdAt: now - 600_000, updatedAt: now, startedAt: now - 600_000, completedAt: now,
		device: 'desktop', deviceLandscape: false, messages: [], activities: [], findings: [], todos: [], secretNames: [], founder: state
	};
	state.status = 'done';
	state.phase = 'report';
	state.report = buildFounderReport(session);
	state.finalizedAt = new Date(now).toISOString();
	session.findings = founderFindings(session);
	session.messages.push(
		{ id: `founder-report-${now}`, role: 'assistant', kind: 'founder-report', ts: now, text: state.report.summary }
	);
	return session;
}
