import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { assertSqaTestBrowser, createSqaTestServer, launchSqaTestBrowser } from './sqa-test-runtime.mjs';

// --isolated is used by the release gate; the optional positional loopback URL
// preserves the existing developer command. No assessment/model turn is started.
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
	browser: { type: 'string', default: 'chromium' }, isolated: { type: 'boolean', default: false }, 'output-dir': { type: 'string' }
} });
assert.ok(positionals.length <= 1 && !(values.isolated && positionals.length), 'Choose an isolated server or one loopback URL.');
const browserName = assertSqaTestBrowser(values.browser);
const directory = path.resolve(values['output-dir'] ?? fileURLToPath(new URL('../test-results/sqa-startup/', import.meta.url)));
await mkdir(directory, { recursive: true });
const runtime = values.isolated ? await createSqaTestServer(directory, { authRequired: true }) : undefined;
const base = new URL(runtime?.base ?? positionals[0] ?? 'http://127.0.0.1:5173');
assert.equal(base.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
let browser;
let modelRequests = 0;

async function scenario({ baseline = false, mobile = false } = {}) {
	const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
	let releaseBoot;
	let signalHeld;
	const bootRelease = new Promise(resolve => { releaseBoot = resolve; });
	const bootHeld = new Promise(resolve => { signalHeld = resolve; });
	let held = false;
	let page;
	const errors = [], failedRequests = [];
	try {
		const registration = await context.request.post(`${base.origin}/api/auth/register`, {
			data: { email: `sqa-startup-${Date.now()}-${mobile ? 'mobile' : 'desktop'}@local.example`, password: 'Local SQA startup regression 2026', displayName: 'SQA startup regression' }
		});
		assert.equal(registration.status(), 201);
		page = await context.newPage();
		await page.route('**/api/sessions/*/message', async route => {
			modelRequests++;
			await route.fulfill({ status: 503, json: { error: 'Model turns are disabled in startup acceptance.' } });
		});
		page.on('pageerror', error => errors.push(error.message));
		page.on('requestfailed', request => failedRequests.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
		if (baseline) {
			// Serve the old launcher/bootstrap behavior to prove this test catches the bug.
			const oldSource = source
				.replace(/\t\/\/ Authentication can expose[\s\S]*?(?=\tsetSqaFormError\(\);)/, '')
				.replaceAll(' && !sqaStartupRequested', '');
			assert.notEqual(oldSource, source);
			await page.route('**/app.js?*', route => route.fulfill({ contentType: 'text/javascript', body: oldSource }));
		}
		await page.route('**/api/sessions', async route => {
			if (route.request().method() === 'GET' && !held) {
				held = true;
				signalHeld();
				await bootRelease;
			}
			await route.continue();
		});
		let catalogAttempts = 0;
		await page.route('**/api/sqa/catalog', route => ++catalogAttempts === 1
			? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Controlled catalog failure.' }) })
			: route.continue());
		await page.goto(base.origin, { waitUntil: 'domcontentloaded' });
		// Cold Firefox on hosted Windows can finish module boot after ten
		// seconds. Keep the request held, with the normal 30s browser deadline.
		let bootTimer;
		try {
			await Promise.race([bootHeld, new Promise((_, reject) => {
				bootTimer = setTimeout(() => reject(new Error('Boot request was not observed within 30 seconds.')), 30_000);
				bootTimer.unref();
			})]);
		} finally { clearTimeout(bootTimer); }
		await page.locator('#new-sqa').click();
		await page.locator('#sqa-catalog-retry').waitFor({ state: 'visible' });
		releaseBoot();
		await page.waitForFunction(() => document.body.dataset.page && !document.body.dataset.pageLoading);
		if (baseline) {
			assert.equal(await page.locator('#qa-start').evaluate(dialog => dialog.open), true);
			await assert.rejects(() => page.locator('#sqa-catalog-retry').click({ trial: true, timeout: 1200 }), /intercepts pointer events|Timeout/);
			console.log('Negative control passed: old startup obstructs the SQA retry action.');
		} else {
			assert.equal(await page.locator('#qa-start').evaluate(dialog => dialog.open), false);
			await page.locator('#sqa-catalog-retry').click();
			await page.locator('#sqa-catalog-state').waitFor({ state: 'hidden' });
			await page.locator('#sqa-customize > summary').click();
			const medicalProfile = page.locator('input[name="sqa-profile"][value="medical"]');
			await medicalProfile.check();
			await page.locator('#sqa-scope-warning').waitFor({ state: 'visible' });
			assert.match(await page.locator('#sqa-scope-warning').textContent(), /Expanded scope adds 3 controls/);
			assert.equal(await page.locator('#sqa-scope-notes').evaluate(input => input.required), true);
			assert.equal(await page.locator('#sqa-expanded-confirmation').isVisible(), true);
			assert.equal(await page.locator('#sqa-expanded-scope').evaluate(input => input.required), true);
			assert.match(await page.locator('#sqa-selection-summary').textContent(), /30 recommended \+ 3 additional/);
			await medicalProfile.uncheck();
			assert.equal(await page.locator('#sqa-scope-warning').isHidden(), true);
			assert.equal(await page.locator('#sqa-scope-notes').evaluate(input => input.required), false);
			assert.equal(await page.locator('#sqa-expanded-confirmation').isHidden(), true);
			await page.locator('#sqa-target-release').fill('startup-regression-build');
			await page.screenshot({ path: `${directory}/${mobile ? 'mobile' : 'desktop'}.png` });
			await page.locator('#sqa-cancel').click();
			await page.locator('#sqa-start').waitFor({ state: 'hidden' });
			assert.equal(await page.locator('#qa-start').evaluate(dialog => dialog.open), false);
			// A later standard QA launch and return to SQA must still work.
			await page.goto(`${base.origin}/#/runs/new`);
			await page.locator('#qa-start[open]').waitFor({ state: 'visible' });
			await page.locator('#qa-cancel').click();
			await page.waitForFunction(() => !document.querySelector('#qa-start').open);
			await page.locator('#new-sqa').click();
			await page.locator('#sqa-start[open]').waitFor({ state: 'visible' });
			assert.equal(await page.locator('#qa-start').evaluate(dialog => dialog.open), false);
			await page.locator('#sqa-target-url').fill('https://example.test');
			await page.locator('#sqa-close').click();
			console.log(`${mobile ? 'Mobile' : 'Desktop'} passed: immediate SQA entry, retry, cancel, and return after QA setup.`);
		}
		assert.deepEqual(errors, []);
	} catch (error) {
		const diagnostic = { browser: browserName, startup: 'failed', scenario: baseline ? 'negative-control' : mobile ? 'mobile' : 'desktop', error: error.message, pageErrors: errors, failedRequests,
			page: await page?.evaluate(() => ({ path: location.pathname, page: document.body.dataset.page, loading: document.body.dataset.pageLoading, authGateVisible: !document.querySelector('#auth-gate')?.hidden })).catch(() => null) };
		await writeFile(`${directory}/result.json`, JSON.stringify(diagnostic, null, 2));
		await page?.screenshot({ path: `${directory}/failure.png` }).catch(() => {});
		throw error;
	} finally {
		releaseBoot();
		await context.close();
	}
}

try {
	await runtime?.start();
	browser = await launchSqaTestBrowser(browserName);
	await scenario({ baseline: true });
	await scenario();
	await scenario({ mobile: true });
	assert.equal(modelRequests, 0);
	const result = { browser: browserName, browserVersion: browser.version(), startup: 'passed', negativeControl: 'passed', desktop: 'passed', mobile: 'passed', modelCalls: modelRequests, isolated: values.isolated };
	await writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} finally {
	await browser?.close();
	await runtime?.stop();
}
