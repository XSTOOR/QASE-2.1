import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { publicQaTestCatalog } from '../server/qaTestCatalog.js';
import { launcherCatalog } from './fixtures/launcher-catalog.mjs';

// Controlled layout qualification only. This server is local, read-only, and
// never creates a run or calls a model. It serves the real dashboard assets and
// bounded API fixtures required to render the launch state.
const publicRoot = path.resolve('public');
const output = path.resolve('test-results', 'studio-demo');
await fs.mkdir(output, { recursive: true });
const fixtureRunId = '12345678-1234-4234-8234-123456789abc';
let fixtureSession;
const fixturePosts = [];

const previewSvg = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760">
  <rect width="1200" height="760" fill="#f7f8fb"/>
  <rect width="1200" height="74" fill="#ffffff"/>
  <rect x="42" y="24" width="132" height="25" rx="7" fill="#315ee8"/>
  <rect x="810" y="27" width="76" height="18" rx="5" fill="#dfe4ee"/>
  <rect x="910" y="27" width="76" height="18" rx="5" fill="#dfe4ee"/>
  <rect x="1010" y="20" width="146" height="32" rx="8" fill="#171717"/>
  <rect x="68" y="142" width="510" height="38" rx="9" fill="#171717"/>
  <rect x="68" y="198" width="448" height="18" rx="5" fill="#a8adb7"/>
  <rect x="68" y="232" width="382" height="18" rx="5" fill="#c5c9d1"/>
  <rect x="68" y="294" width="164" height="44" rx="9" fill="#315ee8"/>
  <rect x="680" y="126" width="448" height="480" rx="18" fill="#ffffff" stroke="#e3e5e8" stroke-width="3"/>
  <rect x="724" y="178" width="316" height="28" rx="6" fill="#171717"/>
  <rect x="724" y="230" width="360" height="54" rx="9" fill="#f0f2f7"/>
  <rect x="724" y="308" width="360" height="54" rx="9" fill="#f0f2f7"/>
  <rect x="724" y="386" width="360" height="54" rx="9" fill="#f0f2f7"/>
  <rect x="724" y="474" width="360" height="54" rx="9" fill="#fee7e7"/>
</svg>`).toString('base64');

function demoSession(status) {
	const running = status === 'running';
	const done = status === 'done';
	return {
		id: fixtureRunId,
		title: 'Checkout release review',
		mode: 'qa',
		status,
		targetUrl: 'https://preview.example.test/',
		createdAt: Date.now() - 185_000,
		updatedAt: Date.now(),
		runStartedAt: Date.now() - 180_000,
		environmentId: 'desktop-chrome',
		environmentSnapshot: { device: 'Desktop', os: 'Windows', osVersion: '11', browser: 'Chrome', browserVersion: 'Current', executionProvider: 'local' },
		runtimeFacts: { executionLevel: 'SIMULATED', executionProvider: 'local' },
		...(done ? { completedAt: Date.now() - 5_000 } : {}),
		messages: [{ id: 'message-1', ts: Date.now() - 170_000, role: 'agent', text: running ? 'Testing the checkout flow and collecting evidence.' : 'Testing finished. Two issues need attention.' }],
		activities: [
			{ id: 'activity-1', ts: Date.now() - 160_000, kind: 'browser', label: 'Opened checkout', status: 'completed' },
			{ id: 'activity-2', ts: Date.now() - 90_000, kind: 'browser', label: running ? 'Checking payment validation' : 'Checked payment validation', status: running ? 'running' : 'completed' }
		],
		todos: [
			{ id: 'todo-1', text: 'Open checkout', status: 'completed' },
			{ id: 'todo-2', text: 'Validate customer details', status: 'completed' },
			{ id: 'todo-3', text: 'Check payment validation', status: running ? 'in_progress' : 'completed' },
			{ id: 'todo-4', text: 'Review confirmation state', status: running ? 'pending' : 'completed' }
		],
		findings: [
			{ id: 'finding-1', title: 'Payment error does not explain the next step', severity: 'high', category: 'forms', url: 'https://preview.example.test/checkout', impact: 'Customers cannot tell how to recover and may abandon checkout.', expected: 'Explain why payment failed and how to retry.', actual: 'A generic error appears with no recovery guidance.', steps: ['Open checkout', 'Use a declined test card', 'Submit payment'], evidence: 'The error region only contains “Something went wrong”.' },
			{ id: 'finding-2', title: 'Order summary clips at narrow widths', severity: 'medium', category: 'responsive', url: 'https://preview.example.test/checkout', impact: 'Mobile customers cannot read the full total.', expected: 'Keep the summary within the viewport.', actual: 'The total extends beyond the card at 360 px.', steps: ['Open checkout at 360 px', 'Review the order summary'], evidence: 'The total is cut off on the right edge.' }
		],
		frame: { mimeType: 'image/svg+xml', base64: previewSvg, viewport: { width: 1200, height: 760 }, url: 'https://preview.example.test/checkout', title: 'Checkout' },
		...(done ? { report: { verdict: 'pass_with_issues', findings: 2, ts: Date.now() - 5_000, summary: 'Checkout works, but payment recovery and the mobile order summary need attention.', bySeverity: { high: 1, medium: 1 }, covered: ['Checkout navigation', 'Customer details', 'Payment validation', 'Responsive layout'], notCovered: ['Production payment settlement'], recommendations: ['Fix the selected issues, then retest checkout.'] } } : {})
	};
}

const contentTypes = new Map([
	['.css', 'text/css; charset=utf-8'],
	['.html', 'text/html; charset=utf-8'],
	['.js', 'text/javascript; charset=utf-8'],
	['.svg', 'image/svg+xml'],
	['.woff2', 'font/woff2']
]);
const json = (response, body, status = 200) => {
	response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	response.end(JSON.stringify(body));
};

const server = http.createServer(async (request, response) => {
	const url = new URL(request.url, 'http://127.0.0.1');
	if (url.pathname.startsWith('/api/')) {
		if (url.pathname === '/api/qa-configurations') return json(response, launcherCatalog());
		if (request.method === 'POST' && url.pathname === '/api/qa-matrix-runs') {
			fixturePosts.push(url.pathname);
			fixtureSession = demoSession('running');
			return json(response, {
				id: 'studio-matrix-fixture',
				status: 'running',
				targetUrl: fixtureSession.targetUrl,
				items: [{ id: 'studio-matrix-item', status: 'RUNNING', sessionId: fixtureRunId }]
			}, 201);
		}
		if (request.method === 'POST' && url.pathname === `/api/sessions/${fixtureRunId}/stop`) {
			fixturePosts.push(url.pathname);
			fixtureSession = { ...fixtureSession, status: 'interrupted', statusDetail: 'Stopped by user.', updatedAt: Date.now() };
			return json(response, { acknowledged: true });
		}
		if (request.method !== 'GET') {
			fixturePosts.push(url.pathname);
			return json(response, { error: 'Read-only Studio fixture.' }, 405);
		}
		if (url.pathname === `/api/sessions/${fixtureRunId}/events`) {
			response.writeHead(200, {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
				connection: 'close'
			});
			response.end('event: ready\ndata: {}\n\n');
			return;
		}
		const body = url.pathname === '/api/auth/me'
			? { id: 'studio-fixture', displayName: 'Demo owner', role: 'owner' }
			: url.pathname === '/api/config'
				? { provider: 'custom', model: 'studio-layout-fixture', ready: true, hasApiKey: true, providers: ['custom'] }
				: url.pathname === '/api/environments/facets'
					? { platform: [], osVersion: [], browser: [], browserVersion: [] }
					: url.pathname === '/api/environments/availability'
						? []
						: url.pathname === '/api/environments'
							? { total: 0, environments: [] }
				: url.pathname === '/api/devices'
					? { default: 'desktop', devices: [{ id: 'desktop', label: 'Desktop', kind: 'desktop' }] }
					: url.pathname === '/api/qa/catalog'
						? publicQaTestCatalog()
						: url.pathname === '/api/sessions'
							? (fixtureSession ? [fixtureSession] : [])
							: url.pathname === `/api/sessions/${fixtureRunId}`
								? fixtureSession
						: url.pathname === '/api/feedback/stats'
							? { total: 0, byCategory: {}, byStatus: {}, byRating: {} }
							: [];
		return json(response, body);
	}

	const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
	const file = path.resolve(publicRoot, relative);
	if (file !== publicRoot && !file.startsWith(`${publicRoot}${path.sep}`)) {
		response.writeHead(404).end();
		return;
	}
	try {
		const body = await fs.readFile(file);
		response.writeHead(200, { 'content-type': contentTypes.get(path.extname(file)) ?? 'application/octet-stream' });
		response.end(body);
	} catch {
		response.writeHead(404).end();
	}
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const checks = [];
const pageErrors = [];

async function open(viewport, studio = true, scenario = 'launcher', overrides = {}) {
	fixtureSession = scenario === 'launcher' ? undefined : { ...demoSession(scenario), ...overrides };
	const page = await browser.newPage({ viewport });
	page.on('pageerror', error => pageErrors.push(error.message));
	const route = studio
		? '/?studio=mock&project=Checkout%20redesign&target=https%3A%2F%2Fpreview.example.test%2F'
		: '/';
	await page.goto(`${base}${route}`);
	await page.locator('.app').waitFor({ state: 'visible' });
	if (scenario === 'launcher') {
		await page.locator('#qa-start[open]').waitFor();
		await page.waitForFunction(() => !document.querySelector('#qa-tests-fieldset').disabled);
		await page.waitForFunction(() => document.querySelector('#qa-matrix-summary').textContent.includes('1 device · 3 browsers · 3 runs'));
	} else {
		try {
			await page.locator('#chat-target').filter({ hasText: 'preview.example.test' }).waitFor({ state: 'attached' });
		} catch (error) {
			console.error(JSON.stringify({
				scenario,
				pageErrors,
				chatTitle: await page.locator('#chat-title').textContent(),
				authVisible: await page.locator('#auth-gate').isVisible(),
				launcherOpen: await page.locator('#qa-start').evaluate(dialog => dialog.open)
			}, null, 2));
			throw error;
		}
	}
	return page;
}

async function paneMetrics(page) {
	return page.evaluate(() => {
		const host = document.querySelector('.studio-host-rail').getBoundingClientRect();
		const context = document.querySelector('#studio-context').getBoundingClientRect();
		const resizer = document.querySelector('#studio-context-resizer').getBoundingClientRect();
		const tool = document.querySelector('.studio-tool-workspace').getBoundingClientRect();
		return {
			hostRight: host.right,
			contextLeft: context.left,
			contextWidth: context.width,
			resizerWidth: resizer.width,
			toolLeft: tool.left,
			toolWidth: tool.width
		};
	});
}

async function dragContextTo(page, requestedWidth) {
	const context = await page.locator('#studio-context').boundingBox();
	const resizer = await page.locator('#studio-context-resizer').boundingBox();
	assert.ok(context && resizer, 'Context and resize handle must be measurable');
	await page.mouse.move(resizer.x + resizer.width / 2, resizer.y + Math.min(120, resizer.height / 2));
	await page.mouse.down();
	await page.mouse.move(context.x + requestedWidth, resizer.y + Math.min(120, resizer.height / 2), { steps: 5 });
	await page.mouse.up();
}

async function assertVisibleControlsNamed(page, context) {
	const unnamed = await page.locator('button:visible').evaluateAll(buttons => buttons
		.filter(button => !(button.getAttribute('aria-label') || button.textContent.trim() || button.getAttribute('title')))
		.map(button => button.id || button.outerHTML.slice(0, 120)));
	assert.deepEqual(unnamed, [], `${context} has no unnamed visible buttons`);
}

try {
	const standalone = await open({ width: 1440, height: 1000 }, false);
	assert.equal(await standalone.locator('html').getAttribute('data-qase-layout'), 'standalone');
	assert.equal(await standalone.locator('.studio-host-rail').isVisible(), false);
	assert.equal(await standalone.locator('#studio-context-resizer').isVisible(), false);
	assert.equal(await standalone.locator('#studio-context-toggle').isVisible(), false);
	assert.equal(await standalone.locator('html').evaluate(node => node.style.getPropertyValue('--studio-context-width')), '');
	assert.equal(await standalone.locator('#sidebar-collapse-toggle').isVisible(), true, 'Default Qase exposes the shared customer navigation collapse control');
	await standalone.locator('#qa-cancel').click();
	assert.equal(await standalone.getByRole('button', { name: 'Start testing', exact: true }).count(), 1, 'Default Qase has one visible Start testing action');
	assert.equal(await standalone.locator('#empty-start').isVisible(), false);
	assert.equal(await standalone.locator('#welcome-checklist').count(), 0, 'Default Qase omits the duplicate onboarding card');
	assert.equal(await standalone.locator('#execution-target-block').isVisible(), false);
	assert.equal(await standalone.locator('#status-chip').isVisible(), false, 'Empty Qase omits the redundant idle status');
	assert.equal(await standalone.locator('#ldv-live').isVisible(), false, 'Empty Qase omits the redundant preview idle status');
	assert.equal(await standalone.locator('#tabs').isVisible(), false, 'Run tabs stay out of the empty state');
	await standalone.screenshot({ path: path.join(output, 'qase-default-empty-1440.png'), animations: 'disabled' });
	await standalone.screenshot({ path: path.join(output, 'product-empty-1440.png'), animations: 'disabled' });
	const standaloneExpandedWidth = await standalone.locator('#workspace-runs').evaluate(node => node.getBoundingClientRect().width);
	await standalone.locator('#sidebar-collapse-toggle').click();
	const standaloneCollapsedWidth = await standalone.locator('#workspace-runs').evaluate(node => node.getBoundingClientRect().width);
	assert.ok(standaloneCollapsedWidth <= 64.5 && standaloneExpandedWidth - standaloneCollapsedWidth >= 100, 'Default Qase uses the shared collapsible customer navigation');
	assert.equal(await standalone.locator('#sidebar-collapse-toggle').getAttribute('aria-label'), 'Expand recent tests sidebar');
	assert.equal(await standalone.locator('#sidebar-new-run').getAttribute('title'), 'Start testing');
	await standalone.screenshot({ path: path.join(output, 'product-sidebar-collapsed-1440.png'), animations: 'disabled' });
	await standalone.locator('#sidebar-collapse-toggle').click();
	await standalone.screenshot({ path: path.join(output, 'standalone-sidebar-regression-1440.png'), animations: 'disabled' });
	await standalone.locator('#empty-demo').click();
	await standalone.locator('#qa-start[open]').waitFor();
	assert.match(await standalone.locator('#qa-target-url').inputValue(), /\/demo$/);
	await standalone.locator('#qa-cancel').click();
	await standalone.locator('#sidebar-new-run').click();
	await standalone.locator('#qa-start[open]').waitFor();
	await standalone.locator('#qa-cancel').click();
	await standalone.locator('#sidebar-tools > summary').click();
	for (const [buttonId, dialogId] of [
		['nav-test-cases', 'test-cases'],
		['nav-device-matrix', 'device-matrix'],
		['nav-bulk-runs', 'bulk-run'],
		['nav-environments', 'environments'],
		['nav-analytics', 'analytics'],
		['nav-settings', 'settings']
	]) {
		await standalone.locator(`#${buttonId}`).click();
		await standalone.waitForFunction(id => document.getElementById(id)?.open === true, dialogId);
		await standalone.keyboard.press('Escape');
	}
	await standalone.locator('#sidebar-tools > summary').click();
	for (const [buttonId, surfaceId, closeId] of [
		['new-sqa', 'sqa-start', 'sqa-cancel'],
		['new-founder', 'founder-start', 'founder-cancel']
	]) {
		await standalone.locator(`#${buttonId}`).click();
		await standalone.locator(`#${surfaceId}[open]`).waitFor();
		await standalone.locator(`#${closeId}`).click();
	}
	await standalone.locator('#open-bugs').click();
	assert.equal(await standalone.locator('#bugs-view').isVisible(), true);
	await standalone.locator('#bugs-close').click();
	await assertVisibleControlsNamed(standalone, 'Empty default Qase');
	checks.push('Default Qase uses the simplified shared product UI without rendering Studio host chrome');
	checks.push('Default Qase Advanced, Quality, Founder, Bugs and demo controls open their existing surfaces');
	await standalone.close();

	const standaloneRunning = await open({ width: 1440, height: 1000 }, false, 'running');
	assert.equal(await standaloneRunning.locator('#tab-plan').getAttribute('aria-selected'), 'true');
	assert.equal(await standaloneRunning.locator('#execution-details').evaluate(node => node.open), false);
	assert.equal(await standaloneRunning.locator('#execution-target-block').isVisible(), false);
	assert.equal(await standaloneRunning.locator('#token-chip').isVisible(), false);
	assert.equal(await standaloneRunning.locator('#live-pill').isVisible(), false);
	assert.equal(await standaloneRunning.locator('#ldv-exec').isVisible(), false);
	assert.equal(await standaloneRunning.locator('#ldv-change-device').isVisible(), false);
	const [standaloneChatWidth, standaloneViewerWidth] = await standaloneRunning.locator('.chat, .viewer')
		.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
	assert.ok(standaloneViewerWidth > standaloneChatWidth * 1.7, 'Default Qase makes the live browser the running-state hero');
	await standaloneRunning.screenshot({ path: path.join(output, 'qase-default-running-1440.png'), animations: 'disabled' });
	await standaloneRunning.screenshot({ path: path.join(output, 'product-running-1440.png'), animations: 'disabled' });
	await standaloneRunning.locator('#execution-details > summary').click();
	assert.equal(await standaloneRunning.locator('#execution-details').evaluate(node => node.open), true);
	for (const detailId of ['run-env-current', 'run-env-execution', 'run-env-session', 'run-env-usage']) {
		assert.equal(await standaloneRunning.locator(`#${detailId}`).isVisible(), true, `${detailId} remains available in Run details`);
	}
	await standaloneRunning.screenshot({ path: path.join(output, 'product-run-details-open-1440.png'), animations: 'disabled' });
	await standaloneRunning.locator('#execution-details > summary').click();
	for (const tabId of ['tab-activity', 'tab-findings', 'tab-plan']) {
		await standaloneRunning.locator(`#${tabId}`).click();
		assert.equal(await standaloneRunning.locator(`#${tabId}`).getAttribute('aria-selected'), 'true');
	}
	await assertVisibleControlsNamed(standaloneRunning, 'Running default Qase');
	await standaloneRunning.locator('#theme-toggle').click();
	await standaloneRunning.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
	await standaloneRunning.screenshot({ path: path.join(output, 'qase-default-running-dark-1440.png'), animations: 'disabled' });
	await standaloneRunning.locator('#stop-run').click();
	await standaloneRunning.locator('#status-chip').filter({ hasText: 'Stopped' }).waitFor();
	assert.equal(fixturePosts.includes(`/api/sessions/${fixtureRunId}/stop`), true, 'Default Qase Stop reaches the existing lifecycle action');
	await standaloneRunning.close();

	const standaloneCompleted = await open({ width: 1440, height: 1000 }, false, 'done');
	assert.equal(await standaloneCompleted.locator('#tab-findings').getAttribute('aria-selected'), 'true');
	assert.equal(await standaloneCompleted.locator('.viewer').evaluate(node => node.classList.contains('stage-collapsed')), true);
	assert.equal(await standaloneCompleted.locator('#ldv-device').textContent(), 'Saved');
	assert.equal(await standaloneCompleted.locator('#ldv-live').textContent(), 'Complete');
	assert.equal(await standaloneCompleted.locator('.findings-selection-count').textContent(), '2 of 2 selected');
	assert.equal(await standaloneCompleted.locator('.finding.is-fixed').count(), 0);
	await standaloneCompleted.screenshot({ path: path.join(output, 'qase-default-completed-1440.png'), animations: 'disabled' });
	await standaloneCompleted.screenshot({ path: path.join(output, 'product-completed-findings-1440.png'), animations: 'disabled' });
	if (!await standaloneCompleted.locator('#sidebar-collapse-toggle').isVisible()) {
		await standaloneCompleted.locator('#results-page-back').click();
		await standaloneCompleted.locator('#sidebar-collapse-toggle').waitFor({ state: 'visible' });
	}
	await standaloneCompleted.locator('#sidebar-collapse-toggle').click();
	assert.equal(await standaloneCompleted.locator('.run-age').isVisible(), false, 'Collapsed run rail hides timestamp text');
	const [collapsedBrandBox, collapsedToggleBox] = await Promise.all([
		standaloneCompleted.locator('.brand-glyph').boundingBox(),
		standaloneCompleted.locator('#sidebar-collapse-toggle').boundingBox()
	]);
	assert.ok(collapsedBrandBox && collapsedToggleBox && collapsedBrandBox.y + collapsedBrandBox.height <= collapsedToggleBox.y,
		'Collapsed brand and expand control occupy separate rows');
	assert.equal(await standaloneCompleted.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false,
		'Collapsed completed workspace does not overflow horizontally');
	await standaloneCompleted.screenshot({ path: path.join(output, 'product-sidebar-collapsed-completed-1440.png'), animations: 'disabled' });
	await standaloneCompleted.locator('#sidebar-collapse-toggle').click();
	const standaloneFirstFinding = standaloneCompleted.locator('.finding-select-input').first();
	await standaloneFirstFinding.uncheck();
	assert.equal(await standaloneCompleted.locator('.findings-selection-count').textContent(), '1 of 2 selected');
	await standaloneCompleted.locator('.findings-selection-all input').check();
	assert.equal(await standaloneCompleted.locator('.findings-selection-count').textContent(), '2 of 2 selected');
	await standaloneCompleted.getByRole('button', { name: 'Copy selected fixes' }).click();
	await standaloneCompleted.locator('.toast').last().waitFor();
	await standaloneCompleted.locator('#stage-toggle').click();
	assert.equal(await standaloneCompleted.locator('#stage-toggle').getAttribute('aria-label'), 'Minimize live preview');
	await standaloneCompleted.locator('#stage-toggle').click();
	assert.equal(await standaloneCompleted.locator('#stage-toggle').getAttribute('aria-label'), 'Show live preview');
	await standaloneCompleted.locator('#tab-report').click();
	assert.equal(await standaloneCompleted.locator('#tab-report').getAttribute('aria-selected'), 'true');
	assert.equal(await standaloneCompleted.getByRole('button', { name: 'Generate test cases' }).isVisible(), false, 'Default Qase keeps developer generation out of primary report actions');
	assert.equal(await standaloneCompleted.locator('.report-developer-actions').evaluate(node => node.open), false);
	await standaloneCompleted.screenshot({ path: path.join(output, 'report-customer-actions.png'), animations: 'disabled' });
	await standaloneCompleted.locator('.report-developer-actions > summary').click();
	assert.equal(await standaloneCompleted.getByRole('button', { name: 'Generate test cases' }).isVisible(), true, 'Default Qase preserves generation under Advanced');
	assert.equal(await standaloneCompleted.getByRole('button', { name: 'Copy all fix prompts' }).isVisible(), true, 'Default Qase preserves fix prompts under Advanced');
	await standaloneCompleted.locator('.report-developer-actions > summary').click();
	const standaloneFeedback = standaloneCompleted.getByRole('button', { name: 'Provide Feedback' });
	if (await standaloneFeedback.isVisible()) {
		await standaloneFeedback.click();
		await standaloneCompleted.locator('#feedback-modal[open]').waitFor();
		await standaloneCompleted.locator('#feedback-cancel').click();
	}
	await standaloneCompleted.locator('#sidebar-new-run').click();
	await standaloneCompleted.locator('#qa-start[open]').waitFor();
	await standaloneCompleted.locator('#qa-cancel').click();
	await assertVisibleControlsNamed(standaloneCompleted, 'Completed default Qase');
	await standaloneCompleted.close();

	const standaloneClean = await open({ width: 1440, height: 1000 }, false, 'done', {
		findings: [],
		frame: undefined,
		report: {
			...demoSession('done').report,
			verdict: 'pass',
			findings: 0,
			bySeverity: {},
			summary: 'Checkout completed without recorded findings.',
			recommendations: ['Keep this checkout flow in focused regression coverage.']
		}
	});
	assert.equal(await standaloneClean.locator('#tab-report').getAttribute('aria-selected'), 'true', 'A clean default-Qase run opens Report');
	assert.equal(await standaloneClean.locator('#pane-report').isVisible(), true);
	assert.match(await standaloneClean.locator('#stage-note').textContent(), /No saved browser image was captured/);
	await standaloneClean.screenshot({ path: path.join(output, 'product-completed-report-1440.png'), animations: 'disabled' });
	await standaloneClean.close();
	checks.push('Running and completed hierarchy is shared by default Qase and the Studio wrapper');

	for (const width of [1280, 768, 390, 360]) {
		const standaloneMobile = await open({ width, height: 844 }, false);
		await standaloneMobile.locator('#qa-cancel').click();
		assert.equal(await standaloneMobile.getByRole('button', { name: 'Start testing', exact: true }).count(), 1, `Default Qase has one visible mobile Start testing action at ${width}px`);
		assert.equal(await standaloneMobile.locator('#sidebar-collapse-toggle').isVisible(), width > 720, 'Sidebar collapse adapts to the mobile breakpoint');
		assert.equal(await standaloneMobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Default Qase has no horizontal overflow at ${width}px`);
		await standaloneMobile.screenshot({ path: path.join(output, `qase-default-empty-${width}.png`), animations: 'disabled' });
		await standaloneMobile.close();
	}

	for (const width of [1280, 768, 390, 360]) {
		const productRunning = await open({ width, height: width <= 390 ? 844 : 900 }, false, 'running');
		const runningLayout = await productRunning.evaluate(() => ({
			fits: document.documentElement.scrollWidth <= innerWidth,
			pageWidth: document.documentElement.scrollWidth,
			viewportWidth: innerWidth,
			boxes: Object.fromEntries(['.app', '.runs', '.chat', '.viewer', '.feature-dock'].map(selector => {
				const rect = document.querySelector(selector).getBoundingClientRect();
				return [selector, { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) }];
			})),
			appStyle: (() => { const style = getComputedStyle(document.querySelector('.app')); return { width: style.width, minWidth: style.minWidth, columns: style.gridTemplateColumns, padding: style.padding }; })(),
			offenders: [...document.querySelectorAll('body *')]
				.filter(node => node.getClientRects().length > 0 && node.getBoundingClientRect().right > innerWidth + 1)
				.slice(0, 12)
				.map(node => ({ id: node.id, className: String(node.className), right: Math.round(node.getBoundingClientRect().right), width: Math.round(node.getBoundingClientRect().width) }))
		}));
		assert.equal(runningLayout.fits, true, `Running Qase has no horizontal overflow at ${width}px: ${JSON.stringify(runningLayout)}`);
		if (width <= 720) {
			assert.equal(await productRunning.locator('body').getAttribute('data-workspace-view'), 'browser');
			assert.equal(await productRunning.locator('.app > .panel:visible').count(), 1);
		} else {
			const viewerTop = await productRunning.locator('.viewer').evaluate(node => node.getBoundingClientRect().top);
			const chatTop = await productRunning.locator('.chat').evaluate(node => node.getBoundingClientRect().top);
			if (width === 768) assert.ok(viewerTop < chatTop, 'Default Qase puts the browser first at tablet width');
		}
		if (width === 768) await productRunning.screenshot({ path: path.join(output, 'product-running-768.png'), animations: 'disabled', fullPage: true });
		await productRunning.close();
	}

	for (const width of [1280, 390, 360]) {
		const productCompleted = await open({ width, height: width <= 390 ? 844 : 900 }, false, 'done');
		assert.equal(await productCompleted.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Completed Qase has no horizontal overflow at ${width}px`);
		assert.equal(await productCompleted.locator('#tab-findings').getAttribute('aria-selected'), 'true');
		if (width <= 720) {
			assert.equal(await productCompleted.locator('body').getAttribute('data-workspace-view'), 'results');
			assert.equal(await productCompleted.locator('.app > .panel:visible').count(), 1);
		}
		if (width === 390) await productCompleted.screenshot({ path: path.join(output, 'product-completed-390.png'), animations: 'disabled' });
		await productCompleted.close();
	}
	checks.push('Default Qase passes empty, running, and completed responsive checks at 1440, 1280, 768, 390, and 360 px');

	const desktop = await open({ width: 1440, height: 1000 });
	assert.equal(await desktop.locator('html').getAttribute('data-qase-layout'), 'studio-mock');
	assert.equal(await desktop.locator('.studio-host-rail').isVisible(), true);
	assert.equal(await desktop.locator('#studio-context').isVisible(), true);
	assert.equal(await desktop.locator('#studio-project-name').textContent(), 'Checkout redesign');
	assert.equal(await desktop.locator('#studio-project-target').textContent(), 'preview.example.test');
	assert.equal(await desktop.locator('#qa-target-url').inputValue(), 'https://preview.example.test/');
	assert.equal(await desktop.locator('#studio-theme-select').isVisible(), true);
	assert.equal(await desktop.locator('.runs .brand-lockup').isVisible(), false, 'Embedded sidebar does not repeat Qase branding');
	assert.equal(await desktop.locator('#sidebar-tools').evaluate(node => node.open), false, 'Advanced tools start closed');
	assert.equal(await desktop.locator('#quick-actions').count(), 0, 'Permanent quick actions are removed');
	await desktop.locator('#studio-theme-select').selectOption('dark');
	assert.equal(await desktop.locator('html').getAttribute('data-theme'), 'dark');
	await desktop.locator('#studio-theme-select').selectOption('light');
	assert.equal(await desktop.locator('html').getAttribute('data-theme'), 'light');
	assert.equal(await desktop.locator('#qa-security-scope').evaluate(node => node.open), false);
	assert.equal(await desktop.locator('#qa-security-notes').isVisible(), false);
	const [contextWidth, toolWidth] = await desktop.locator('#studio-context, .studio-tool-workspace')
		.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
	assert.ok(toolWidth > contextWidth * 3, 'Qase receives most of the Studio workspace');
	await desktop.screenshot({ path: path.join(output, 'studio-launcher-1440.png'), animations: 'disabled' });
	await desktop.locator('#qa-cancel').click();
	assert.equal(await desktop.getByRole('button', { name: 'Start testing', exact: true }).count(), 1, 'Empty Studio view has one visible primary Start testing action');
	assert.equal(await desktop.locator('#empty-start').isVisible(), false, 'Duplicate empty-state primary action stays hidden in Studio');
	assert.equal(await desktop.locator('#empty-demo').isVisible(), true, 'Demo remains a secondary action');
	await desktop.screenshot({ path: path.join(output, 'studio-empty-final-1440.png'), animations: 'disabled' });
	await desktop.locator('#empty-demo').click();
	await desktop.locator('#qa-start[open]').waitFor();
	assert.match(await desktop.locator('#qa-target-url').inputValue(), /\/demo$/);
	await desktop.locator('#qa-cancel').click();
	await desktop.locator('#composer-input').fill('https://preview.example.test/checkout');
	await desktop.locator('#composer-input').press('Enter');
	await desktop.locator('#qa-start[open]').waitFor();
	assert.equal(await desktop.locator('#qa-target-url').inputValue(), 'https://preview.example.test/checkout');
	await desktop.locator('#qa-cancel').click();
	await desktop.locator('#composer-input').fill('');
	const expandedSidebarWidth = await desktop.locator('#workspace-runs').evaluate(node => node.getBoundingClientRect().width);
	await desktop.screenshot({ path: path.join(output, 'studio-sidebar-expanded-1440.png'), animations: 'disabled' });
	await desktop.locator('#sidebar-tools > summary').click();
	for (const [buttonId, dialogId] of [
		['nav-test-cases', 'test-cases'],
		['nav-device-matrix', 'device-matrix'],
		['nav-bulk-runs', 'bulk-run'],
		['nav-environments', 'environments'],
		['nav-analytics', 'analytics'],
		['nav-settings', 'settings']
	]) {
		await desktop.locator(`#${buttonId}`).click();
		await desktop.waitForFunction(id => document.getElementById(id)?.open === true, dialogId);
		assert.deepEqual(pageErrors, [], `${buttonId} opens without a page error`);
		await desktop.keyboard.press('Escape');
	}
	checks.push('Every Advanced navigation control opens its existing working surface');
	const sidebarToggle = desktop.locator('#sidebar-collapse-toggle');
	assert.equal(await sidebarToggle.getAttribute('aria-expanded'), 'true');
	assert.equal(await sidebarToggle.getAttribute('title'), 'Collapse sidebar');
	await sidebarToggle.focus();
	await desktop.keyboard.press('Enter');
	assert.equal(await sidebarToggle.getAttribute('aria-expanded'), 'false');
	assert.equal(await sidebarToggle.getAttribute('aria-label'), 'Expand recent tests sidebar');
	assert.equal(await desktop.locator('#sidebar-tools').evaluate(node => node.open), false, 'Collapsing closes Advanced content');
	const collapsedSidebarWidth = await desktop.locator('#workspace-runs').evaluate(node => node.getBoundingClientRect().width);
	assert.ok(collapsedSidebarWidth <= 64.5, 'Collapsed sidebar becomes a narrow icon rail');
	assert.ok(expandedSidebarWidth - collapsedSidebarWidth >= 100, 'Collapsing gives meaningful width back to the workspace');
	assert.equal(await desktop.locator('#sidebar-new-run').getAttribute('title'), 'Start testing');
	await desktop.screenshot({ path: path.join(output, 'studio-sidebar-collapsed-1440.png'), animations: 'disabled' });
	await desktop.reload();
	assert.equal(await desktop.locator('html').getAttribute('data-qase-sidebar'), 'collapsed', 'Sidebar preference survives reload');
	await desktop.locator('#qa-cancel').click();
	await sidebarToggle.focus();
	await desktop.keyboard.press('Enter');
	assert.equal(await sidebarToggle.getAttribute('aria-expanded'), 'true', 'Keyboard expands the sidebar');
	const separator = desktop.locator('#studio-context-resizer');
	assert.equal(await separator.getAttribute('role'), 'separator');
	assert.equal(await separator.getAttribute('aria-orientation'), 'vertical');
	assert.equal(await separator.getAttribute('aria-valuemin'), '220');
	assert.equal(await separator.getAttribute('aria-valuemax'), '340');
	assert.equal(Math.round((await paneMetrics(desktop)).contextWidth), 280, 'Context uses its comfortable default width');
	await desktop.screenshot({ path: path.join(output, 'studio-context-default-1440.png'), animations: 'disabled' });

	await separator.focus();
	await desktop.keyboard.press('Home');
	assert.equal(await separator.getAttribute('aria-valuenow'), '220');
	assert.equal(Math.round((await paneMetrics(desktop)).contextWidth), 220, 'Home reaches the minimum context width');
	await desktop.screenshot({ path: path.join(output, 'studio-context-narrow-1440.png'), animations: 'disabled' });
	await desktop.keyboard.press('ArrowRight');
	assert.equal(await separator.getAttribute('aria-valuenow'), '228', 'Arrow keys resize in precise steps');
	await desktop.keyboard.press('Shift+ArrowRight');
	assert.equal(await separator.getAttribute('aria-valuenow'), '252', 'Shift and Arrow resize in larger steps');
	await desktop.keyboard.press('End');
	assert.equal(await separator.getAttribute('aria-valuenow'), '340');
	assert.equal(Math.round((await paneMetrics(desktop)).contextWidth), 340, 'End reaches the maximum context width');
	await desktop.screenshot({ path: path.join(output, 'studio-context-wide-1440.png'), animations: 'disabled' });

	await dragContextTo(desktop, 180);
	assert.equal(Math.round((await paneMetrics(desktop)).contextWidth), 220, 'Pointer resizing clamps to the minimum');
	await dragContextTo(desktop, 420);
	assert.equal(Math.round((await paneMetrics(desktop)).contextWidth), 340, 'Pointer resizing clamps to the maximum');
	await separator.focus();
	await desktop.keyboard.press('Home');
	await desktop.keyboard.press('ArrowRight');
	await desktop.keyboard.press('Shift+ArrowRight');
	assert.equal(await separator.getAttribute('aria-valuenow'), '252');
	await desktop.reload();
	await desktop.locator('.app').waitFor({ state: 'visible' });
	await desktop.locator('#qa-cancel').click();
	assert.equal(await desktop.locator('#studio-context-resizer').getAttribute('aria-valuenow'), '252', 'Context width survives reload');
	const expandedContextMetrics = await paneMetrics(desktop);
	await desktop.locator('#studio-context-toggle').click();
	assert.equal(await desktop.locator('#studio-context-toggle').getAttribute('aria-expanded'), 'false');
	assert.equal(await desktop.locator('#studio-context-toggle').getAttribute('aria-label'), 'Show project context');
	assert.equal(await desktop.locator('#studio-context').isVisible(), false);
	assert.equal(await desktop.locator('#studio-context-resizer').isVisible(), false);
	const collapsedContextMetrics = await paneMetrics(desktop);
	assert.ok(
		collapsedContextMetrics.toolWidth > expandedContextMetrics.toolWidth + 250,
		`Qase immediately receives the released pane width: ${JSON.stringify({ expandedContextMetrics, collapsedContextMetrics })}`
	);
	assert.ok(Math.abs(collapsedContextMetrics.toolLeft - collapsedContextMetrics.hostRight) <= 1, 'Collapsed context leaves no empty gutter');
	await desktop.screenshot({ path: path.join(output, 'studio-context-hidden-1440.png'), animations: 'disabled' });
	await desktop.reload();
	await desktop.locator('.app').waitFor({ state: 'visible' });
	await desktop.locator('#qa-cancel').click();
	assert.equal(await desktop.locator('html').getAttribute('data-studio-context'), 'collapsed', 'Collapsed context state survives reload');
	await desktop.locator('#studio-context-toggle').click();
	assert.equal(await desktop.locator('#studio-context-resizer').getAttribute('aria-valuenow'), '252', 'Restoring context preserves the previous width');
	assert.equal(Math.round((await paneMetrics(desktop)).contextWidth), 252);
	await desktop.evaluate(() => {
		localStorage.setItem('qase.studio.contextWidth', '9999');
		localStorage.setItem('qase.studio.contextState', 'corrupted');
	});
	await desktop.reload();
	await desktop.locator('.app').waitFor({ state: 'visible' });
	await desktop.locator('#qa-cancel').click();
	assert.equal(await desktop.locator('#studio-context-resizer').getAttribute('aria-valuenow'), '280', 'Invalid stored width recovers to the default');
	assert.equal(await desktop.locator('html').getAttribute('data-studio-context'), 'expanded', 'Invalid stored state recovers safely');

	for (const [buttonId, surfaceId, closeId] of [
		['new-run', 'qa-start', 'qa-cancel'],
		['new-sqa', 'sqa-start', 'sqa-cancel'],
		['new-founder', 'founder-start', 'founder-cancel']
	]) {
		await desktop.locator(`#${buttonId}`).click();
		await desktop.locator(`#${surfaceId}[open]`).waitFor();
		await desktop.locator(`#${closeId}`).click();
	}
	await desktop.locator('#open-bugs').click();
	assert.equal(await desktop.locator('#bugs-view').isVisible(), true);
	await desktop.locator('#bugs-close').click();
	assert.equal(await desktop.locator('#bugs-view').isVisible(), false);
	checks.push('Studio shell shows host navigation, project context, and a larger Qase center workspace');
	checks.push('Sidebar expands and collapses by keyboard, persists semantics, and returns meaningful workspace width');
	checks.push('Context resizes by pointer and keyboard, clamps to 220–340 px, persists, collapses without a gutter, and restores its previous width');
	checks.push('Test, Quality, Ideas and Bugs mode controls open and close their working surfaces');
	checks.push('Empty Studio view keeps one primary Start testing action while demo and URL composer remain functional');
	await desktop.close();

	const studioLaunch = await open({ width: 1440, height: 1000 }, true, 'launcher');
	const studioMatrixPostsBefore = fixturePosts.filter(pathname => pathname === '/api/qa-matrix-runs').length;
	assert.equal(await studioLaunch.locator('#qa-target-url').inputValue(), 'https://preview.example.test/');
	assert.equal(await studioLaunch.locator('#qa-security-auth').isHidden(), true, 'Standard Studio QA does not demand security authorization');
	assert.equal(await studioLaunch.locator('#qa-submit').isEnabled(), true, 'Studio prefill enables the shared standard launcher');
	await studioLaunch.locator('#qa-submit').click();
	await studioLaunch.locator('#qa-start').waitFor({ state: 'hidden' });
	await studioLaunch.waitForFunction(id => localStorage.getItem('qase.session') === id && document.body.dataset.runStatus === 'running', fixtureRunId);
	assert.equal(fixturePosts.filter(pathname => pathname === '/api/qa-matrix-runs').length, studioMatrixPostsBefore + 1, 'Studio submits through the shared matrix-run endpoint exactly once');
	checks.push('Studio project target prefills the shared launcher, creates one standard run, and enters the running workspace');
	await studioLaunch.evaluate(() => localStorage.removeItem('qase.session'));
	await studioLaunch.close();

	const tabletSidebar = await open({ width: 768, height: 900 });
	await tabletSidebar.locator('#qa-cancel').click();
	assert.equal(await tabletSidebar.locator('#studio-context').isVisible(), false, 'Project context does not squeeze the tablet workspace');
	assert.equal(await tabletSidebar.locator('#studio-context-resizer').isVisible(), false, 'Desktop resize handle is disabled at tablet width');
	assert.equal(await tabletSidebar.locator('#studio-context-toggle').isVisible(), false);
	await tabletSidebar.locator('#sidebar-collapse-toggle').click();
	assert.equal(await tabletSidebar.locator('#workspace-runs').evaluate(node => Math.round(node.getBoundingClientRect().width)), 64);
	assert.equal(await tabletSidebar.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
	await tabletSidebar.screenshot({ path: path.join(output, 'studio-sidebar-collapsed-768.png'), animations: 'disabled' });
	await tabletSidebar.screenshot({ path: path.join(output, 'studio-responsive-768.png'), animations: 'disabled' });
	await tabletSidebar.locator('#sidebar-collapse-toggle').click();
	await tabletSidebar.close();

	const running = await open({ width: 1440, height: 1000 }, true, 'running');
	assert.equal(await running.locator('#status-chip').textContent(), 'Running');
	assert.equal(await running.locator('#chat-title').textContent(), 'Testing preview.example.test');
	assert.equal(await running.locator('#stop-run').isVisible(), true);
	assert.equal(await running.locator('#current-activity-state').textContent(), 'Checking payment validation');
	assert.equal(await running.locator('#current-activity .ca-label').textContent(), 'Current activity');
	assert.equal(await running.locator('#progress-steps').textContent(), '2/4');
	assert.equal(await running.locator('#count-findings').textContent(), '2');
	assert.equal(await running.locator('#progress-findings').isVisible(), true);
	assert.equal(await running.locator('#stage-inner').isVisible(), true);
	assert.equal(await running.locator('#tab-plan').getAttribute('aria-selected'), 'true', 'Running QA opens with the supporting plan visible');
	assert.equal(await running.locator('#pane-plan').isVisible(), true);
	assert.equal(await running.locator('#plan-list .todo.in_progress').isVisible(), true, 'Current plan step is visible');
	assert.equal(await running.locator('#execution-details').isVisible(), true);
	assert.equal(await running.locator('#execution-details').evaluate(node => node.open), false, 'Technical execution metadata starts closed');
	assert.equal(await running.locator('#execution-target-block').isVisible(), false, 'Legacy execution metadata card does not duplicate Run details in Studio');
	assert.equal(await running.locator('#live-pill').isVisible(), false, 'Header status is not duplicated by a second live pill');
	assert.equal(await running.locator('#composer-input').isDisabled(), true);
	assert.equal(await running.locator('#composer-running-hint').isVisible(), true);
	assert.equal(await running.locator('#composer').evaluate(node => node.scrollWidth <= node.clientWidth), true);
	const [heroChatWidth, heroViewerWidth] = await running.locator('.chat, .viewer')
		.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
	assert.ok(heroViewerWidth > heroChatWidth * 1.7, 'Live browser is the clear running-state hero');
	await running.screenshot({ path: path.join(output, 'studio-running-final-1440.png'), animations: 'disabled' });
	await running.screenshot({ path: path.join(output, 'studio-wrapper-running-1440.png'), animations: 'disabled' });
	await running.locator('#execution-details > summary').click();
	assert.equal(await running.locator('#execution-details').evaluate(node => node.open), true);
	for (const detailId of ['run-env-current', 'run-env-execution', 'run-env-session', 'run-env-usage']) {
		assert.equal(await running.locator(`#${detailId}`).isVisible(), true, `${detailId} is available on intentional disclosure`);
	}
	await running.screenshot({ path: path.join(output, 'studio-running-details-open-1440.png'), animations: 'disabled' });
	await running.locator('#execution-details > summary').click();
	await running.locator('#progress-findings').click();
	assert.equal(await running.locator('#tab-findings').getAttribute('aria-selected'), 'true', 'Findings count opens findings without closing the browser');
	await running.locator('#tab-plan').click();
	await running.locator('#studio-context-resizer').focus();
	await running.keyboard.press('Home');
	assert.equal(await running.locator('#studio-context-resizer').getAttribute('aria-valuenow'), '220');
	const [runningChatWidth, runningViewerWidth] = await running.locator('.chat, .viewer')
		.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
	assert.ok(runningViewerWidth > runningChatWidth * 1.7, 'Live browser receives substantially more width than conversation');
	const modeDock = await running.locator('.feature-dock').boundingBox();
	assert.ok(modeDock && modeDock.width <= 76, 'Mode rail remains narrow');
	for (const modeId of ['new-run', 'new-sqa', 'new-founder', 'open-bugs']) {
		const mode = running.locator(`#${modeId}`);
		await mode.focus();
		assert.equal(await running.evaluate(id => document.activeElement?.id === id, modeId), true, `${modeId} is keyboard reachable`);
		assert.equal(await mode.locator('.feature-label').isVisible(), true, `${modeId} keeps its readable label`);
	}
	const recentRun = running.locator('#run-list .run').first();
	assert.equal(await recentRun.isVisible(), true);
	await recentRun.click();
	assert.equal(await recentRun.getAttribute('aria-current'), 'true', 'Recent test remains selectable');
	for (const tabId of ['tab-plan', 'tab-findings', 'tab-activity']) {
		const tab = running.locator(`#${tabId}`);
		await tab.click();
		assert.equal(await tab.getAttribute('aria-selected'), 'true', `${tabId} remains accessible beside the live browser`);
	}
	await running.screenshot({ path: path.join(output, 'studio-running-context-narrow-1440.png'), animations: 'disabled' });
	await running.screenshot({ path: path.join(output, 'studio-running-1440.png'), animations: 'disabled' });
	assert.equal(await running.locator('body').evaluate(node=>getComputedStyle(node).textTransform), 'none', 'Body does not inherit stray uppercase declarations');
	assert.equal(await running.locator('.transcript').evaluate(node=>getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)', 'Light conversation uses the Studio surface');
	await running.locator('#studio-theme-select').selectOption('dark');
	assert.deepEqual(await running.locator('[data-theme-control]').evaluateAll(nodes=>nodes.map(n=>n.value)), ['dark', 'dark', 'dark']);
	assert.equal(await running.locator('.transcript').evaluate(node=>getComputedStyle(node).backgroundColor), 'rgb(26, 26, 29)', 'Dark conversation uses the Studio surface');
	await running.screenshot({ path: path.join(output, 'studio-running-dark-1440.png'), animations: 'disabled' });
	await running.reload();
	assert.equal(await running.locator('#studio-theme-select').inputValue(), 'dark', 'Theme survives reload');
	await running.locator('#studio-theme-select').selectOption('system');
	await running.emulateMedia({ colorScheme: 'dark' });
	await running.waitForFunction(()=>document.documentElement.dataset.theme === 'dark');
	await running.emulateMedia({ colorScheme: 'light' });
	await running.waitForFunction(()=>document.documentElement.dataset.theme === 'light');
	await running.locator('#stop-run').click();
	await running.locator('#status-chip').filter({ hasText: 'Stopped' }).waitFor();
	assert.equal(fixturePosts.includes(`/api/sessions/${fixtureRunId}/stop`), true, 'Stop reaches the real stop action and reconciles saved state');
	checks.push('Light, dark and System stay synchronized across all theme controls and reloads');
	checks.push('Running fixture makes the live browser primary, reveals Plan by default, keeps current activity and findings accessible, and hides execution metadata until requested');
	checks.push('Stop invokes the run lifecycle action and reconciles the authoritative stopped state');
	await running.close();

	const completed = await open({ width: 1440, height: 1000 }, true, 'done');
	await completed.locator('.viewer.stage-collapsed').waitFor();
	assert.equal(await completed.locator('#chat-title').textContent(), 'Testing complete');
	assert.equal(await completed.locator('#tab-findings').getAttribute('aria-selected'), 'true');
	assert.equal(await completed.locator('.findings-selection-count').textContent(), '2 of 2 selected');
	assert.equal(await completed.locator('.finding.is-fixed').count(), 0, 'Selected findings are not presented as fixed');
	assert.equal(await completed.locator('#stage-toggle').getAttribute('aria-label'), 'Show live preview');
	assert.equal(await completed.locator('#sidebar-view-report').count(), 0);
	assert.equal(await completed.locator('#sidebar-retest').count(), 0);
	assert.equal(await completed.locator('#perf-panel').count(), 0);
	await completed.screenshot({ path: path.join(output, 'studio-completed-findings-1440.png'), animations: 'disabled' });
	const firstFinding = completed.locator('.finding-select-input').first();
	await firstFinding.uncheck();
	assert.equal(await completed.locator('.findings-selection-count').textContent(), '1 of 2 selected');
	await completed.locator('.findings-selection-all input').check();
	assert.equal(await completed.locator('.findings-selection-count').textContent(), '2 of 2 selected');
	await completed.getByRole('button', { name: 'Copy selected fixes' }).click();
	const copyToast = completed.locator('.toast').last();
	await copyToast.waitFor({ state: 'visible' });
	await copyToast.evaluate((node) => node.remove());
	await completed.locator('#tab-report').click();
	assert.equal(await completed.locator('#tab-report').getAttribute('aria-selected'), 'true');
	const reportHeadings = await completed.locator('#report-view .report-section h3').allTextContents();
	assert.deepEqual(reportHeadings.slice(0, 2), ['Summary', 'Recommended next action'], 'Report leads with result context and next action');
	assert.equal(await completed.getByRole('button', { name: 'Generate test cases' }).isVisible(), false, 'Developer test generation is not a primary customer action');
	assert.equal(await completed.locator('.report-developer-actions').evaluate(node => node.open), false, 'Developer report actions start closed');
	await completed.screenshot({ path: path.join(output, 'studio-report-customer-actions.png'), animations: 'disabled' });
	await completed.locator('.report-developer-actions > summary').click();
	assert.equal(await completed.getByRole('button', { name: 'Generate test cases' }).isVisible(), true, 'Developer test generation remains available under Advanced');
	assert.equal(await completed.getByRole('button', { name: 'Copy all fix prompts' }).isVisible(), true, 'Fix prompt tools remain available under Advanced');
	await completed.locator('.report-developer-actions > summary').click();
	await completed.screenshot({ path: path.join(output, 'studio-completed-report-1440.png'), animations: 'disabled' });
	const feedbackButton = completed.getByRole('button', { name: 'Provide Feedback' });
	if (await feedbackButton.isVisible()) {
		await feedbackButton.click();
		await completed.locator('#feedback-modal[open]').waitFor();
		await completed.locator('#feedback-cancel').click();
	}
	if (!await completed.locator('#sidebar-new-run').isVisible()) {
		await completed.locator('#results-page-back').click();
		await completed.locator('#sidebar-new-run').waitFor({ state: 'visible' });
	}
	await completed.locator('#sidebar-new-run').click();
	await completed.locator('#qa-start[open]').waitFor();
	await completed.locator('#qa-cancel').click();
	await completed.locator('#tab-findings').click();
	await completed.locator('#conn-label').filter({ hasText: 'results ready' }).waitFor();
	const [stageRight, previewRight] = await completed.locator('#stage, #stage-inner')
		.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().right));
	assert.ok(stageRight - previewRight <= 16, 'Completed preview thumbnail sits at the upper-right edge');
	await completed.locator('#stage-toggle').click();
	assert.equal(await completed.locator('.viewer').evaluate(node => node.classList.contains('stage-collapsed')), false, 'Show preview expands the saved browser image');
	assert.equal(await completed.locator('#stage-toggle').getAttribute('aria-label'), 'Minimize live preview');
	await completed.screenshot({ path: path.join(output, 'studio-completed-preview-expanded-1440.png'), animations: 'disabled' });
	await completed.locator('#stage-toggle').click();
	assert.equal(await completed.locator('.viewer').evaluate(node => node.classList.contains('stage-collapsed')), true, 'Minimize preview restores the accepted thumbnail state');
	assert.equal(await completed.locator('#stage-toggle').getAttribute('aria-label'), 'Show live preview');
	const [chatWidth, viewerWidth] = await completed.locator('.chat, .viewer')
		.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
	assert.ok(viewerWidth > chatWidth * 1.75, 'Results receive substantially more width than conversation');
	for (const tabId of ['tab-activity', 'tab-plan', 'tab-report', 'tab-findings']) {
		await completed.locator(`#${tabId}`).click();
		assert.equal(await completed.locator(`#${tabId}`).getAttribute('aria-selected'), 'true', `${tabId} remains functional after completion`);
	}
	await completed.locator('#studio-context-resizer').focus();
	await completed.keyboard.press('Home');
	await completed.screenshot({ path: path.join(output, 'studio-completed-context-narrow-1440.png'), animations: 'disabled' });
	await completed.screenshot({ path: path.join(output, 'studio-completed-1440.png'), animations: 'disabled' });
	checks.push('Completed fixture automatically prioritizes findings, preserves exact selection, leads the report with product-owner information, and keeps preview and primary Start testing controls functional');
	await completed.close();

	const tabletRunning = await open({ width: 768, height: 900 }, true, 'running');
	const tabletViewerTop = await tabletRunning.locator('.viewer').evaluate(node => node.getBoundingClientRect().top);
	const tabletChatTop = await tabletRunning.locator('.chat').evaluate(node => node.getBoundingClientRect().top);
	assert.ok(tabletViewerTop < tabletChatTop, 'Tablet puts the live browser before conversation while running');
	assert.equal(await tabletRunning.locator('#studio-context-resizer').isVisible(), false);
	assert.equal(await tabletRunning.locator('#tabs .tab').evaluateAll(nodes => nodes
		.filter(node => node.getClientRects().length > 0)
		.every((node, index, visibleNodes) => {
		if (index === 0) return true;
		return node.getBoundingClientRect().left >= visibleNodes[index - 1].getBoundingClientRect().right - 1;
	})), true, 'Tablet tabs remain separated and horizontally reachable');
	await tabletRunning.screenshot({ path: path.join(output, 'studio-running-768.png'), animations: 'disabled', fullPage: true });
	await tabletRunning.close();

	const mobileRunning = await open({ width: 390, height: 844 }, true, 'running');
	assert.equal(await mobileRunning.locator('body').getAttribute('data-workspace-view'), 'browser', 'Mobile running state opens the browser-first flow');
	assert.equal(await mobileRunning.locator('.viewer').isVisible(), true);
	await mobileRunning.close();
	checks.push('Tablet and mobile running states put the live browser before supporting conversation content');

	for (const width of [1280, 768, 390, 360]) {
		const page = await open({ width, height: width <= 390 ? 844 : 900 });
		assert.equal(await page.locator('#studio-context-resizer').isVisible(), width === 1280, `Resize handle adapts at ${width}px`);
		assert.equal(await page.locator('#studio-context').isVisible(), width === 1280, `Project context adapts at ${width}px`);
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
		if (overflow) console.error(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1 && node.getBoundingClientRect().width > 0).slice(0, 20).map(node => ({tag: node.tagName, id: node.id, class: node.className, width: node.getBoundingClientRect().width}))));
		assert.equal(overflow, false, `No horizontal overflow at ${width}px`);
		assert.equal(await page.locator('#qa-submit').isVisible(), true, `Primary action visible at ${width}px`);
		await page.screenshot({ path: path.join(output, `studio-launcher-${width}.png`), animations: 'disabled', fullPage: width <= 390 });
		await page.locator('#qa-customize > summary').click();
		await page.locator('#qa-matrix-root').scrollIntoViewIfNeeded();
		assert.equal(await page.locator('#qa-start').evaluate(node=>node.scrollWidth <= node.clientWidth), true, `Expanded setup fits at ${width}px`);
		assert.equal(await page.locator('#qa-submit').evaluate(node=>{const r=node.getBoundingClientRect();return r.top >= 0 && r.bottom <= innerHeight;}), true, 'Start action remains within viewport');
		await page.screenshot({ path: path.join(output, `studio-setup-expanded-${width}.png`), animations: 'disabled' });
		await page.locator('#studio-theme-select').selectOption('dark');
		await page.screenshot({ path: path.join(output, `studio-setup-dark-${width}.png`), animations: 'disabled' });
		await page.keyboard.press('Escape');
		assert.equal(await page.locator('#qa-start').evaluate(node=>node.open), false, 'Escape closes setup');
		checks.push(`Studio launcher remains usable at ${width}px`);
		await page.close();
	}

	assert.deepEqual(pageErrors, [], 'No browser runtime errors');
	for (const studio of [false, true]) {
		const mobile = await open({ width: 390, height: 844 }, studio, 'done');
		assert.equal(await mobile.locator('body').getAttribute('data-workspace-view'), 'results');
		assert.equal(await mobile.locator('.findings-selection-count').isVisible(), true);
		if (!await mobile.locator('button[data-workspace-view="agent"]').isVisible()) {
			await mobile.locator('#results-page-back').click();
			await mobile.locator('button[data-workspace-view="agent"]').waitFor({ state: 'visible' });
		}
		for (const [view, panel] of [['agent', '.chat'], ['runs', '.runs'], ['browser', '.viewer'], ['results', '.viewer']]) {
			await mobile.locator(`button[data-workspace-view="${view}"]`).click();
			assert.equal(await mobile.locator(panel).isVisible(), true);
			assert.equal(await mobile.locator('.app > .panel:visible').count(), 1, 'One main panel is visible on mobile');
			if (view === 'browser') assert.ok((await mobile.locator('#stage-inner').boundingBox()).width > 200, 'Browser panel expands the saved preview');
			const layout = await mobile.evaluate(()=>({width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, viewport: [innerWidth,innerHeight], overflowing: [...document.querySelectorAll('.app, .app > *, .panel > *')].filter(node=>node.getBoundingClientRect().bottom > innerHeight+1 || node.getBoundingClientRect().right > innerWidth+1).map(node=>({id:node.id, class:node.className, bottom:node.getBoundingClientRect().bottom, right:node.getBoundingClientRect().right}))}));
			await mobile.screenshot({ path: path.join(output, `mobile-${studio ? 'studio' : 'standalone'}-${view}.png`), animations: 'disabled' });
			if (studio && view === 'results') {
				await mobile.screenshot({ path: path.join(output, 'studio-completed-390.png'), animations: 'disabled' });
			}
			assert.ok(layout.width <= 390 && layout.height <= 845, `Mobile ${view} fits: ${JSON.stringify(layout)}`);
		}
		await mobile.setViewportSize({ width: 1440, height: 1000 });
		assert.equal(await mobile.locator('.app > .panel:visible').count(), 3, 'Desktop restores every workspace panel');
		await mobile.close();
	}
	checks.push('Mobile panel navigation, automatic results focus and desktop resize work in both layouts');
	for (const status of ['awaiting_input', 'interrupted', 'error', 'done']) {
		const cleanOverrides = status === 'done'
			? { findings: [], frame: undefined, report: { ...demoSession('done').report, verdict: 'pass', findings: 0, bySeverity: {}, summary: 'Checkout completed without recorded findings.', recommendations: ['Keep this checkout flow in focused regression coverage.'] } }
			: {};
		const page = await open({ width: 1280, height: 900 }, true, status, cleanOverrides);
		if (status === 'interrupted' || status === 'error') {
			assert.equal(await page.locator('#resume-run').isVisible(), true);
			await page.locator('#conn-label').filter({hasText: 'updates paused'}).waitFor();
		}
		if (status === 'awaiting_input') {
			assert.equal(await page.locator('#composer-input').isEnabled(), true);
			await page.locator('#composer-input').fill('Please continue with the checkout review.');
			await page.locator('#composer-input').press('Enter');
			await page.waitForTimeout(100);
			assert.equal(fixturePosts.includes(`/api/sessions/${fixtureRunId}/message`), true, 'Send input reaches the real message action');
		}
		if (status === 'done') {
			await page.locator('#stage-note').filter({hasText: 'No saved browser image'}).waitFor();
			assert.equal(await page.locator('#tab-report').getAttribute('aria-selected'), 'true', 'Clean completed runs default to Report');
			await page.locator('#tab-findings').click();
			await page.getByText('No findings recorded for this run.', {exact:false}).waitFor();
		}
		await page.screenshot({ path: path.join(output, `studio-state-${status}.png`), animations: 'disabled' });
		await page.close();
	}
	checks.push('Waiting, interrupted, error, empty findings and missing-preview states expose honest recovery guidance');
	assert.deepEqual(pageErrors, [], 'No browser runtime errors after mobile navigation');
	const result = {
		passed: true,
		checks,
		pageErrors,
		limitations: 'Controlled local browser fixture. It verifies run creation UI and lifecycle transitions without calling a model or claiming exact hosted Studio parity.'
	};
	await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} finally {
	await browser.close();
	await new Promise(resolve => server.close(resolve));
}
