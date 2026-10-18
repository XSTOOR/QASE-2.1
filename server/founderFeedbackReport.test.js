import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApplication } from './app.js';
import { createMemoryServices, TEST_TENANT } from './app.test.js';
import { createInstanceAccess } from './instanceAccess.js';

/* #16654 — founder report downloads embed the USER FEEDBACK section, same as
 * the QA/SQA branches. Reuses app.test.js's memory service harness so the
 * full application service contract is satisfied. */

async function startFixture() {
	const memory = createMemoryServices();
	const application = createApplication({
		services: memory.services,
		access: createInstanceAccess({ tenantContext: TEST_TENANT }),
		environment: {},
		demoEnabled: false,
		probeTargetReachability: async () => ({ ok: true })
	});
	const server = await new Promise(resolve => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	const origin = `http://127.0.0.1:${server.address().port}`;
	return {
		...memory,
		...application,
		origin,
		close: async () => {
			await application.whenIdle();
			await new Promise(resolve => server.close(resolve));
		}
	};
}

function seedFounderRun(services) {
	const session = services.runs.create('Founder feedback md fixture', {
		mode: 'founder',
		status: 'done',
		targetUrl: 'https://example.com/',
		founder: {
			scope: { target: { name: 'Acme AI', url: 'https://example.com/' } },
			observations: [],
			report: {
				schemaVersion: '2026.08.1',
				generatedAt: '2026-10-17T00:00:00.000Z',
				target: { name: 'Acme AI', url: 'https://example.com/' },
				coverage: { categoriesReviewed: ['positioning'], totalCategories: 12, evidenceBackedObservations: 1 },
				evidenceConfidence: {},
				executiveSummary: 'Reduce onboarding friction.',
				icp: { primary: 'Solo founders', users: [], buyers: [], jobs: [], pains: [] },
				positioning: { category: 'QA automation', oneLiner: 'Ship confident', valueProposition: 'Fast QA', differentiators: [], alternatives: [] },
				recommendations: [],
				marketing: { channels: [], contentAngles: [], launchMotions: [], growthLoops: [], assumptions: [] },
				sales: { motion: 'Founder-led', qualificationQuestions: [], objectionResponses: [], salesAssets: [] },
				risks: [],
				quickWins: [],
				plan: { days30: [], days60: [], days90: [] },
				metrics: { northStar: { name: 'Runs', definition: 'Weekly runs', why: 'Usage' }, candidates: [], experiments: [] },
				caveat: 'Evidence-informed guidance.'
			},
			finalizedAt: '2026-10-17T00:00:00.000Z'
		}
	});
	return session;
}

test('#16654 founder report.md embeds USER FEEDBACK when feedback exists', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const session = seedFounderRun(fixture.services);
	await fixture.services.feedback.create({
		runId: session.id,
		// Embedded-instance requests are anonymous (no authService in the
		// fixture), which is how this flow actually reports — same as the QA
		// report fixtures in app.test.js.
		submittedBy: undefined,
		context: { targetUrl: session.targetUrl, runStatus: 'done' },
		rating: 4,
		comments: 'Founder review flow was thorough',
		improvement: 'Add competitor comparison'
	});
	const response = await fetch(`${fixture.origin}/api/sessions/${session.id}/report.md`);
	assert.equal(response.status, 200);
	const markdown = await response.text();
	assert.match(markdown, /# Founder review/i);
	assert.match(markdown, /User Feedback/i);
	assert.match(markdown, /Founder review flow was thorough/);
	assert.match(markdown, /Add competitor comparison/);
});

test('#16654 founder report.md omits the section cleanly without feedback', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const session = seedFounderRun(fixture.services);
	const response = await fetch(`${fixture.origin}/api/sessions/${session.id}/report.md`);
	assert.equal(response.status, 200);
	const markdown = await response.text();
	assert.match(markdown, /# Founder review/i);
	assert.doesNotMatch(markdown, /User Feedback/i);
});
