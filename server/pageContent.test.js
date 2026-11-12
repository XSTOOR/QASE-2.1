import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { readPageContent } from './pageContent.js';
import { createBrowserTools } from './browserTools.js';
import { rememberFounderEvidence } from './founderInvestigation.js';
import { buildFounderSynthesisContext } from './founderPrompt.js';
import { createFounderDraftTool } from './founderReportDraft.js';
import { createFounderReportFixture } from './founderReportFixture.js';
import { founderReportToolSchema } from './founderTools.js';
import { createFounderState, finishFounderReview, FOUNDER_CATEGORY_IDS, recordFounderObservation } from './founderService.js';

test('page reader exposes truncation and finds late pricing without exposing form values', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.setContent(`<main>${'Intro content '.repeat(120)}<h2>Model rates</h2><p>Input $1.40 per million tokens</p><input value="private-field-value"><textarea>private-textarea-value</textarea><select><option>private-option-value</option></select><div contenteditable="true">private-editor-value</div><div hidden>hidden-panel-value</div></main>`);
		const first = await readPageContent(page, { limit: 1000 });
		assert.equal(first.complete, false); assert.equal(first.nextOffset, 1000);
		const last = await readPageContent(page, { offset: first.nextOffset, limit: 1000 });
		assert.equal(last.complete, true); assert.equal(last.nextOffset, null);
		assert.match(last.text, /Input \$1\.40/);
		assert.doesNotMatch(first.text + last.text, /private-field-value|private-textarea-value|private-option-value|private-editor-value|hidden-panel-value/);
		await assert.rejects(() => readPageContent(page, { limit: 12001 }), /Invalid bounded/);
		const tool = createBrowserTools(() => ({ readPageContent: input => readPageContent(page, input) })).find(t => t.name === 'browser_read_page');
		assert.equal((await tool.run({ offset: -1 })).success, false);
		assert.equal((await tool.run({ script: 'ignored' })).success, false);
		assert.equal((await tool.run(null)).success, false);
		assert.equal((await tool.run([])).success, false);
	} finally { await browser.close(); }
});

test('late published rates survive restart and block a false Founder recommendation', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		const url = 'https://fixture.test/pricing';
		await page.route(url, route => route.fulfill({
			contentType: 'text/html',
			body: `<main><h1>Pricing</h1><p>${'Plan details '.repeat(480)}</p>
				<p hidden>Input $99.00 per million tokens</p>
				<textarea>Input $99.00 per million tokens</textarea>
			</main>`
		}));
		await page.goto(url);
		const { session, payload } = createFounderReportFixture();
		session.messages = [];
		session.activities = [];
		session.founder = {
			...createFounderState({ authorizationConfirmed: true, target: { name: 'Fixture', url } }),
			reportGeneration: { version: 1, protocol: 'section-draft-v1', evidenceHashVersion: 1 }
		};
		const store = { async commit() {} };
		const read = async id => {
			const result = await readPageContent(page, { limit: 5000 });
			session.activities.push({ id, status: 'done', toolName: 'browser_read_page', summary: 'Read pricing page.' });
			await rememberFounderEvidence(session, store, { toolName: 'browser_read_page', activityId: id, result });
			return result;
		};
		const partial = await read('partial-pricing');
		assert.equal(partial.nextOffset, 5000);
		assert.deepEqual(partial.tokenRateExcerpts, []);
		const observation = {
			category: 'monetization_pricing', type: 'opportunity', title: 'No token rates are visible',
			summary: 'No token rates are published before signup.', confidence: 'medium',
			evidence_activity_ids: ['partial-pricing']
		};
		await assert.rejects(recordFounderObservation(session, observation, store), /do not establish that token rates are absent/);
		await recordFounderObservation(session, {
			...observation, title: 'Token rates unverified',
			summary: 'No token rates were observed in the sampled page text. The pricing page read was partial.'
		}, store);

		await page.locator('main').evaluate(main => main.insertAdjacentHTML('beforeend',
			'<section><h2>Model rates</h2><p>Usage Per M tokens</p><dl><dt>Input</dt><dd>$1.40</dd><dt>Output</dt><dd>$4.40</dd></dl></section>'));
		const pricing = await read('published-pricing');
		assert.equal(pricing.complete, false);
		assert.doesNotMatch(pricing.text, /\$1\.40/);
		assert.deepEqual(pricing.tokenRateExcerpts, ['Per M tokens Input $1.40 Output $4.40']);
		const restored = JSON.parse(JSON.stringify(session));
		assert.match(buildFounderSynthesisContext(restored), /Per M tokens Input \$1\.40 Output \$4\.40/);
		await assert.rejects(recordFounderObservation(restored, observation, store), /already shows token rates/);
		const supported = await recordFounderObservation(restored, {
			...observation, title: 'Input and output token rates are listed',
			summary: 'The public pricing page shows $1.40 input and $4.40 output per million tokens.',
			evidence_activity_ids: ['published-pricing']
		}, store);
		assert.equal(supported.evidence[0].activityId, 'published-pricing');

		restored.founder.observations.push(...FOUNDER_CATEGORY_IDS.filter(category => category !== supported.category)
			.map(category => ({ ...supported, category, id: category === 'product_clarity' ? 'observed' : category })));
		payload.monetization.pricing_presentation = supported.summary;
		payload.monetization.evidence_observation_ids = [supported.id];
		const schema = founderReportToolSchema();
		const draft = createFounderDraftTool(restored, store, schema);
		for (const section of ['executive_summary', 'icp', 'positioning', 'monetization']) {
			assert.equal((await draft.run({ section, value: payload[section] })).success, true);
		}
		const contradictory = { ...payload.recommendations[0], title: 'Publish token rates and a worked cost example before signup' };
		const rejected = await draft.run({ section: 'recommendations', value: [contradictory] });
		assert.equal(rejected.success, false);
		assert.match(rejected.error, /already shows token rates/);
		await assert.rejects(finishFounderReview(restored, {
			...payload, recommendations: [contradictory, ...payload.recommendations.slice(1)]
		}, store), /already shows token rates/);
		await assert.rejects(finishFounderReview(restored, {
			...payload, executive_summary: 'Model-usage costs show no visible rates before signup.'
		}, store), /already shows token rates/);
		assert.equal(restored.founder.finalizedAt, undefined);
		const report = await finishFounderReview(restored, payload, store);
		assert.equal(report.recommendations.length, 3);
		assert.equal(report.monetization.pricingPresentation, supported.summary);
	} finally {
		await browser.close();
	}
});
