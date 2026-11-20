/**
 * Compliance testing (SQA), end to end in the real UI.
 *
 * Starts an isolated Qase server, the QA Lab (its BrightPath education site has
 * planted compliance gaps), a scripted OpenAI-compatible reasoning model and a
 * SearXNG-shaped search stub. Then it drives the browser exactly as a user
 * would: open the SQA launcher, enter the URL and context, start, answer the
 * sign-in question if one is asked, wait for the report card in the
 * conversation, and check the Compliance tab, the report tab and the exports.
 * No live model or network: everything is local.
 *
 *   node scripts/test-sqa-browser.mjs [--browser chromium] [--output-dir dir]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { request } from 'playwright';
import { assertSqaTestBrowser, createSqaTestServer, launchSqaTestBrowser } from './sqa-test-runtime.mjs';
import { startQaLab } from '../server/qa/fixtureSite.js';
import { startScriptedModel, startSearchStub } from '../server/sqa/testDoubles.js';

const { values } = parseArgs({ options: { browser: { type: 'string', default: 'chromium' }, 'output-dir': { type: 'string' } } });
const browserName = assertSqaTestBrowser(values.browser);
const output = path.resolve(values['output-dir'] ?? `test-results/sqa-browser/${browserName}`);
await fs.mkdir(output, { recursive: true });

const lab = await startQaLab();
const model = await startScriptedModel();
const search = await startSearchStub();
const runtime = await createSqaTestServer(path.join(output, `runtime-${Date.now()}`), {
	authRequired: true,
	env: {
		QASE_REASONER_BASE_URL: model.url, QASE_REASONER_MODEL: 'scripted-analyst', QASE_REASONER_API_KEY: 'fixture-only-key',
		QASE_SQA_SEARCH_URL: search.url, QASE_ALLOW_PRIVATE_NETWORK: 'true', QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1',
		QASE_SQA_MAX_MINUTES: '12', QASE_SQA_KEY_PAGES: '6'
	}
});
const checks = [], errors = [];
let browser, page, api;
const target = `${lab.url}edu/`;

try {
	await runtime.start();
	api = await request.newContext({ baseURL: runtime.base });
	const registered = await api.post('/api/auth/register', { data: { email: `sqa-${randomUUID()}@example.test`, displayName: 'Compliance owner', password: `Compliance fixture ${randomUUID()}` } });
	assert.equal(registered.status(), 201);
	const csrf = decodeURIComponent((await api.storageState()).cookies.find(cookie => cookie.name === 'qase_csrf').value);
	assert.equal((await api.put('/api/config', { headers: { Origin: runtime.base, 'X-CSRF-Token': csrf }, data: { provider: 'custom', model: 'scripted-analyst', baseUrl: model.url, apiKey: 'fixture-only-key' } })).status(), 200);

	browser = await launchSqaTestBrowser(browserName);
	const context = await browser.newContext({ storageState: await api.storageState(), viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
	page = await context.newPage();
	page.on('pageerror', error => errors.push(error.message));
	await page.goto(`${runtime.base}/#/runs`);
	await page.locator('#auth-gate').waitFor({ state: 'hidden' });

	// Launcher
	await page.locator('#new-sqa').click();
	await page.locator('#sqa-start[open]').waitFor();
	assert.equal(await page.locator('#sqa-submit').isDisabled(), true, 'nothing filled in: start is disabled');
	assert.match(await page.locator('#sqa-launch-status').innerText(), /product URL/);
	await page.locator('#sqa-target-url').fill(target);
	await page.locator('#sqa-customize > summary').click();
	await page.locator('#sqa-focus').fill('Online classes for school children; parents create the accounts.');
	await page.locator('#sqa-regions').fill('India, United States');
	await page.locator('#sqa-authorization').check();
	await page.waitForFunction(() => !document.querySelector('#sqa-submit').disabled, null, { timeout: 15_000 });
	await page.screenshot({ path: path.join(output, 'launcher.png') });
	await page.locator('#sqa-submit').click();
	await page.locator('#sqa-start').waitFor({ state: 'hidden' });
	checks.push('Launcher: URL, context and permission are required before start; the run starts from the dialog.');

	// The agent works in the conversation; answer a sign-in question if one is asked.
	await page.locator('#tab-sqa').waitFor({ state: 'visible' });
	const deadline = Date.now() + 8 * 60_000;
	let answeredSignIn = false;
	while (Date.now() < deadline) {
		if (await page.locator('.qa-msg.sqa-report').count()) break;
		if (!answeredSignIn && await page.locator('.qa-signin-card').count()) {
			await page.screenshot({ path: path.join(output, 'signin-question.png') });
			const skip = page.locator('.qa-signin-card button', { hasText: /public|skip/i }).first();
			if (await skip.count()) await skip.click();
			else { await page.locator('#composer-input').fill('skip'); await page.locator('#send-btn').click(); }
			answeredSignIn = true;
			checks.push('The agent asked for a test account in the conversation; answering "public pages only" continued the run.');
		}
		await page.waitForTimeout(1000);
	}
	await page.locator('.qa-msg.sqa-report').waitFor({ timeout: 5000 });
	const conversation = await page.locator('#transcript, .transcript, #messages').first().innerText().catch(() => page.locator('body').innerText());
	assert.match(conversation, /What kind of product|This looks like/i, 'the agent narrates the product identification');
	const card = await page.locator('.qa-msg.sqa-report').innerText();
	for (const expected of [/Compliance test complete/, /Serious gaps/, /COPPA\s+0%/, /DPDP/, /Open compliance report/]) assert.match(card, expected);
	// The finished run asks for feedback, as every run does; close it.
	await page.locator('#feedback-modal[open]').waitFor({ timeout: 5000 }).catch(() => {});
	if (await page.locator('#feedback-modal[open]').count()) await page.locator('#feedback-close').click();
	await page.screenshot({ path: path.join(output, 'conversation.png') });
	checks.push('The agent narrates each stage in the conversation and posts a compliance report card with per-standard scores.');

	// Compliance tab
	await page.locator('#tab-sqa').click();
	const view = page.locator('#sqa-view .cmp-compliance');
	await view.waitFor();
	const text = await view.innerText();
	for (const expected of [/BrightPath/, /Education \/ e-learning/, /Children/, /COPPA/, /WCAG 2\.2/, /DPDP/, /Legally required/, /Consent before tracking/, /Privacy notice covers children/, /Needs documents/, /Research sources/])
		assert.match(text, expected);
	assert.doesNotMatch(text, /Made-up Standard/, 'the unsourced framework was rejected');
	await page.locator('#sqa-view .cmp-req.is-fail summary').first().click();
	assert.match(await page.locator('#sqa-view .cmp-req.is-fail[open]').first().innerText(), /Fix/);
	for (const width of [1440, 390]) {
		await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
		assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no horizontal overflow at ${width}px`);
		await page.screenshot({ path: path.join(output, `compliance-${width}.png`), fullPage: width > 500 });
	}
	await page.setViewportSize({ width: 1440, height: 1000 });
	for (const [name, selector] of [['standards', '.cmp-frameworks'], ['requirements', '.cmp-req.is-fail'], ['evidence', '.cmp-evidence']]) {
		await page.locator(`#sqa-view ${selector}`).first().scrollIntoViewIfNeeded();
		await page.screenshot({ path: path.join(output, `compliance-${name}.png`) });
	}
	checks.push('Compliance tab: product profile, researched standards with sources, every requirement with result, evidence and fix; no overflow on mobile.');

	// Findings and exports
	const runId = new URL(page.url()).hash.match(/runs\/([^/]+)/)?.[1];
	assert.ok(runId, 'the run route is retained');
	const session = await (await api.get(`/api/sessions/${runId}`)).json();
	assert.equal(session.status, 'done');
	assert.equal(session.report.verdict, 'non_compliant');
	assert.ok(session.findings.length >= 4 && session.findings.every(item => item.category === 'compliance'));
	const markdown = await (await api.get(`/api/sessions/${runId}/report.md`)).text();
	assert.match(markdown, /## Frameworks assessed[\s\S]*COPPA/);
	const pdf = await api.get(`/api/sessions/${runId}/report.pdf`);
	assert.equal(pdf.status(), 200);
	assert.match(pdf.headers()['content-type'], /pdf/);
	checks.push('Failed requirements become compliance findings; Markdown and PDF reports export.');
	assert.ok(model.log.length >= 6 && search.queries.length >= 1, 'the reasoning model and the web search were used');
	assert.deepEqual(errors, []);
	const result = { status: 'passed', browser: browserName, browserVersion: browser.version(), checks, modelCalls: model.log.length, searches: search.queries, javascriptErrors: errors };
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
