/**
 * Founder review, end to end in the real UI.
 *
 * Starts an isolated Qase server, the QA Lab (its Taskly SaaS site has planted
 * business gaps: vague headline, CTA below the fold, 404 pricing, a 9-field
 * sign-up, mobile overflow), a scripted OpenAI-compatible reasoning model and a
 * search stub with competitor results. Then it drives the browser as a founder
 * would: open the Founder launcher, enter the URL and the brief, start, wait
 * for the review card in the conversation, and check the Founder tab, the
 * report tab, the Studio selection and the exports. Everything is local.
 *
 *   node scripts/test-founder-browser.mjs [--browser chromium] [--output-dir dir]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { request } from 'playwright';
import { assertSqaTestBrowser, createSqaTestServer, launchSqaTestBrowser } from './sqa-test-runtime.mjs';
import { startQaLab } from '../server/qa/fixtureSite.js';
import { startSearchStub } from '../server/sqa/testDoubles.js';
import { COMPETITOR_RESULTS, startFounderModel } from '../server/founder/testDoubles.js';

const { values } = parseArgs({ options: { browser: { type: 'string', default: 'chromium' }, 'output-dir': { type: 'string' } } });
const browserName = assertSqaTestBrowser(values.browser);
const output = path.resolve(values['output-dir'] ?? `test-results/founder-browser/${browserName}`);
await fs.mkdir(output, { recursive: true });

const lab = await startQaLab();
const model = await startFounderModel();
const search = await startSearchStub(COMPETITOR_RESULTS);
const runtime = await createSqaTestServer(path.join(output, `runtime-${Date.now()}`), {
	authRequired: true,
	env: {
		QASE_REASONER_BASE_URL: model.url, QASE_REASONER_MODEL: 'scripted-founder', QASE_REASONER_API_KEY: 'fixture-only-key',
		QASE_SQA_SEARCH_URL: search.url, QASE_ALLOW_PRIVATE_NETWORK: 'true', QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1',
		QASE_FOUNDER_MAX_MINUTES: '12', QASE_FOUNDER_KEY_PAGES: '6', QASE_QA_ASK_CREDENTIALS: 'false'
	}
});
const checks = [], errors = [];
let browser, page, api;
const target = `${lab.url}saas/`;

try {
	await runtime.start();
	api = await request.newContext({ baseURL: runtime.base });
	const registered = await api.post('/api/auth/register', { data: { email: `founder-${randomUUID()}@example.test`, displayName: 'Founder', password: `Founder fixture ${randomUUID()}` } });
	assert.equal(registered.status(), 201);
	const csrf = decodeURIComponent((await api.storageState()).cookies.find(cookie => cookie.name === 'qase_csrf').value);
	assert.equal((await api.put('/api/config', { headers: { Origin: runtime.base, 'X-CSRF-Token': csrf }, data: { provider: 'custom', model: 'scripted-founder', baseUrl: model.url, apiKey: 'fixture-only-key' } })).status(), 200);

	browser = await launchSqaTestBrowser(browserName);
	const context = await browser.newContext({ storageState: await api.storageState(), viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
	page = await context.newPage();
	page.on('pageerror', error => errors.push(error.message));
	await page.goto(`${runtime.base}/#/runs`);
	await page.locator('#auth-gate').waitFor({ state: 'hidden' });

	// Launcher: URL, permission and the owner's brief.
	await page.waitForFunction(() => document.body.dataset.page && !document.body.dataset.pageLoading);
	// A new account lands on the new-test page, which offers each mode.
	if (await page.locator('#qa-start[open]').count()) await page.locator('#qa-launch-founder').click();
	else await page.locator('#new-founder').click();
	await page.locator('#founder-start[open]').waitFor();
	assert.equal(await page.locator('#founder-submit').isDisabled(), true, 'nothing filled in: start is disabled');
	assert.match(await page.locator('#founder-launch-status').innerText(), /product URL/);
	await page.locator('#founder-target-url').fill(target);
	await page.locator('#founder-goals').fill('Get small agencies to start a free trial and invite their team.');
	await page.locator('#founder-audience').fill('Small agencies');
	await page.locator('#founder-stage').selectOption('early');
	await page.locator('#founder-journeys').fill('Invite a teammate');
	await page.locator('#founder-competitors').fill('asana.com');
	await page.locator('.founder-focus-chip:has(input[value="onboarding"])').click();
	await page.locator('#founder-authorization').check();
	await page.waitForFunction(() => !document.querySelector('#founder-submit').disabled, null, { timeout: 15_000 });
	await page.screenshot({ path: path.join(output, 'launcher.png') });
	await page.locator('#founder-submit').click();
	await page.locator('#founder-start').waitFor({ state: 'hidden' });
	checks.push('Launcher: URL and permission are required; goals, customers, stage, journeys, competitors and focus go to the review.');

	// The agent works in the conversation and posts the review card.
	await page.locator('#tab-founder').waitFor({ state: 'visible' });
	// While it works: one clean header, a live status pill, the working line.
	await page.locator('#status-chip[data-status="running"]').waitFor({ timeout: 60_000 });
	await page.locator('#transcript .msg.agent').nth(1).waitFor({ timeout: 60_000 });
	assert.equal(await page.locator('#token-chip').isVisible(), false, 'no token counter in the header');
	assert.doesNotMatch(await page.locator('#chat-target').innerText(), /what to do, avoid and keep/i, 'no tagline in the header');
	await page.screenshot({ path: path.join(output, 'running.png') });
	await page.locator('.qa-msg.founder-report').waitFor({ timeout: 8 * 60_000 });
	const card = await page.locator('.qa-msg.founder-report').innerText();
	for (const expected of [/Founder review complete/, /Not ready to scale|Major gaps/, /to do now/, /Open the review/i]) assert.match(card, expected);
	assert.ok(await page.locator('.qa-msg.founder-rec').count() >= 1, 'do-now recommendations are posted in the conversation');
	await page.locator('#feedback-modal[open]').waitFor({ timeout: 5000 }).catch(() => {});
	if (await page.locator('#feedback-modal[open]').count()) await page.locator('#feedback-close').click();
	await page.screenshot({ path: path.join(output, 'conversation.png') });
	checks.push('The agent narrates the review in the conversation, then posts the readiness card and each do-now recommendation.');

	// Founder tab: the business review.
	await page.locator('#tab-founder').click();
	const view = page.locator('#founder-view .fdr-review');
	await view.waitFor();
	const text = await view.innerText();
	for (const expected of [/Readiness/i, /Do now/i, /Avoid/i, /Keep doing/i, /Scorecard/, /Asana/, /Trello/, /Invite a teammate/, /Blocked/, /pricing/i])
		assert.match(text, expected);
	assert.doesNotMatch(text, /Made-up|Invented/i, 'the competitor without a found source was rejected');
	assert.equal(await page.locator('#founder-view .fdr-lens').count(), 10);
	assert.match(await page.locator('#founder-view .fdr-rec').first().innerText(), /R1/);
	await page.locator('#founder-view .fdr-lens summary').first().click();
	for (const width of [1440, 390]) {
		await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
		assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no horizontal overflow at ${width}px`);
		await page.screenshot({ path: path.join(output, `founder-${width}.png`), fullPage: width > 500 });
	}
	await page.setViewportSize({ width: 1440, height: 1000 });
	for (const [name, selector] of [['recommendations', '.fdr-rec-group'], ['scorecard', '.fdr-lenses'], ['journeys', '.fdr-journey'], ['market', '.fdr-competitors']]) {
		await page.locator(`#founder-view ${selector}`).first().scrollIntoViewIfNeeded();
		await page.screenshot({ path: path.join(output, `founder-${name}.png`) });
	}
	checks.push('Founder tab: readiness, verdict, do / avoid / keep advice, ten-lens scorecard, journeys, competitors and signals; no overflow on mobile.');

	// Findings and exports.
	const runId = new URL(page.url()).hash.match(/runs\/([^/]+)/)?.[1];
	assert.ok(runId, 'the run route is retained');
	const session = await (await api.get(`/api/sessions/${runId}`)).json();
	assert.equal(session.status, 'done');
	assert.equal(session.founder.brief.audience, 'Small agencies');
	assert.equal(session.founder.journeyPlan[0].name, 'Invite a teammate', "the owner's journey is walked first");
	assert.ok(session.founder.report.readiness < 60);
	assert.ok(session.findings.length >= 1 && session.findings.every(item => item.category === 'business'));
	const markdown = await (await api.get(`/api/sessions/${runId}/report.md`)).text();
	assert.match(markdown, /Readiness/i);
	const pdf = await api.get(`/api/sessions/${runId}/report.pdf`);
	assert.equal(pdf.status(), 200);
	assert.match(pdf.headers()['content-type'], /pdf/);
	checks.push('Do-now recommendations become business findings; Markdown and PDF reviews export.');
	assert.ok(model.log.length >= 8 && search.queries.length >= 1, 'the reasoning model and the web search were used');
	assert.deepEqual(errors, []);
	const result = { status: 'passed', browser: browserName, browserVersion: browser.version(), checks, readiness: session.founder.report.readiness, modelCalls: model.log.length, searches: search.queries, javascriptErrors: errors };
	await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} catch (error) {
	await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
	await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'failed', checks, error: error.message, javascriptErrors: errors }, null, 2));
	throw error;
} finally {
	await browser?.close();
	await api?.dispose();
	await runtime.stop();
	await model.close();
	await search.close();
	await lab.close();
}
