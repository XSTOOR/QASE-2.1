import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApplication } from '../server/app.js';
import { buildReportMarkdown } from '../server/report.js';
import { launcherCatalog, launcherConfigurations } from './fixtures/launcher-catalog.mjs';

// Real dashboard + HTTP handlers, isolated in-memory storage and a stub model.
const sessions = new Map();
const turns = [];
const listeners = new Map();
const publish = (s, type, payload = {}) => { for (const listener of listeners.get(s.id) ?? []) listener({ type, sessionId:s.id, ts:Date.now(), ...payload }); };
const config = { provider:'custom', model:'dashboard-fixture', ready:true, hasApiKey:true, providers:['custom'], headless:true };
const tenantContext = { organizationId:randomUUID(), projectId:randomUUID(), actorUserId:randomUUID(), actorEmail:'fixture@example.test', actorName:'Fixture owner' };
const services = {
	tenantContext,
	feedback: { async create(input){ return input; }, async get(){ return null; }, async list(){ return []; }, async update(){ return null; }, async remove(){ return null; }, async stats(){ return { total: 0, byCategory: {}, byStatus: {}, byRating: {} }; }, async forRun(){ return null; } },
	runs: {
		load(){}, async create(title = 'New test run', options = {}) { const s = {id:randomUUID(),title,mode:'qa',createdAt:Date.now(),updatedAt:Date.now(),status:'idle',messages:[],activities:[],findings:[],todos:[],secretNames:[],...options};sessions.set(s.id,s);return s; },
		get:id=>sessions.get(id), list:()=>[...sessions.values()], async delete(id){return sessions.delete(id);},
		async commit(s,type,payload){publish(s,type,payload);},
		async addMessage(s,item){const message={id:randomUUID(),ts:Date.now(),...item};s.messages.push(message);publish(s,'message',{message});return message;},
		async addActivity(s,item){const activity={id:randomUUID(),ts:Date.now(),...item};s.activities.push(activity);return activity;},
		async updateActivity(s,id,patch){Object.assign(s.activities.find(a=>a.id===id),patch);},
		async setStatus(s,status){s.status=status;publish(s,'status',{status});}
	},
	events:{publish,async subscribe(id,listener){await new Promise(resolve=>setTimeout(resolve,150));const group=listeners.get(id)??new Set();group.add(listener);listeners.set(id,group);return()=>group.delete(listener);}},
	configuration:{getPublic:()=>config,save:()=>config,testConnection:async()=>({ok:true,models:['dashboard-fixture']})},
	secrets:{clear(){},names:()=>[],store:()=>[]}, reports:{buildMarkdown:buildReportMarkdown},
	agent:{ensureRuntime(){},async runTurn(s,options){turns.push({mode:s.mode,options});await services.runs.setStatus(s,'idle');},closeBrowser:async()=>{},getLiveState:()=>({running:false}),stop(){},invalidateIdleRuntimes:()=>({kept:0})},
	environments: {
		seed(){}, async list(){ return []; },
		async facets(){ return { total: 0, devices: [], osVersions: [], browsers: [] }; },
		async get(){ return null; }, async create(){ return {}; }, async update(){ return null; },
		async availability(){ return { available: 0, busy: 0 }; }, async catalogVersion(){ return 'fixture'; }
	},
	bugs: { async list(){ return []; }, async get(){ return null; }, async create(input){ return input; }, async update(){ return null; }, async remove(){ return null; } },
	readiness:{check:async()=>({ready:true})}, lifecycle:{close:async()=>{}}
};
const application = createApplication({services,environment:{NODE_ENV:'production'}});
const server = await new Promise(resolve=>{const s=application.app.listen(0,'127.0.0.1',()=>resolve(s));});
const streams = new Map();
server.on('request', (request, response) => {
	const match = request.url.match(/^\/api\/sessions\/([^/]+)\/events$/);
	if (match) streams.set(match[1], response);
});
const base = `http://127.0.0.1:${server.address().port}`;
// Exercise the real preflight against this fixture, without external DNS/model access.
const targetUrl = `${base}/healthz`;
const output = path.resolve('test-results','dashboard');fs.mkdirSync(output,{recursive:true});
const browser = await chromium.launch({executablePath:chromium.executablePath()});
const errors = [];
const checks = [];
const reportSources = {};
const settleTeardown = promise => Promise.race([
	promise,
	new Promise(resolve => {
		const timer = setTimeout(resolve, 2_000);
		timer.unref();
	})
]);
const screenshot = async (page, name) => {
	await page.screenshot({path:path.join(output,name), animations:'disabled'});
};
try {
	const page = await browser.newPage({viewport:{width:1440,height:1000}});
	page.on('pageerror',error=>errors.push(error.message));
	// Matrix execution is a bounded HTTP fixture; session, SQA and Founder
	// handlers below still exercise the real application with a stub agent.
	let matrixRequest;
	let matrixRequestCount = 0;
	let rejectNextMatrixRequest = false;
	let successfulMatrixSessionId;
	let catalogRequestCount = 0;
	let failNextCatalogRequest = true;
	let matrixRun = { id: 'matrix-fixture', status: 'pending', items: [], targetUrl: 'https://example.test/' };
	await page.route('**/api/qa-configurations*', route => {
		catalogRequestCount += 1;
		if (failNextCatalogRequest) {
			failNextCatalogRequest = false;
			return route.fulfill({ status: 503, json: { error: 'Device catalog temporarily unavailable.' } });
		}
		return route.fulfill({ json: launcherCatalog() });
	});
	await page.route('**/api/qa-matrix-runs', async route => {
		matrixRequestCount += 1;
		matrixRequest = route.request().postDataJSON();
		if (rejectNextMatrixRequest) {
			rejectNextMatrixRequest = false;
			return route.fulfill({ status: 503, json: { error: 'The run service is temporarily unavailable.' } });
		}
		const created = await services.runs.create('QA run — https://example.test/', {
			targetUrl: matrixRequest.targetUrl,
			selectedTests: matrixRequest.selectedTests,
			scopeSelection: matrixRequest.scopeSelection,
			environmentId: matrixRequest.configurationEnvIds[0],
			environmentSnapshot: { envId: matrixRequest.configurationEnvIds[0], device: 'Desktop', os: 'Windows', osVersion: '11', browser: 'Edge', browserVersion: '140' }
		});
		created.status = 'running';
		created.runStartedAt = Date.now();
		created.updatedAt = Date.now();
		successfulMatrixSessionId = created.id;
		matrixRun = {
			id: 'matrix-fixture', status: 'running', targetUrl: matrixRequest.targetUrl,
			itemCount: matrixRequest.configurationEnvIds.length,
			items: matrixRequest.configurationEnvIds.map((envId, index) => {
				const configuration = launcherConfigurations.find(row => row.envId === envId);
				return {
					id: `matrix-item-${index}`, ordinal: index, environmentId: envId,
					platform: configuration.platform, device: configuration.device,
					os: configuration.os, osVersion: configuration.osVersion,
					browser: configuration.browserCode, browserCode: configuration.browserCode,
					browserVersion: configuration.browserVersion,
					status: index === 0 ? 'RUNNING' : 'QUEUED',
					sessionId: index === 0 ? created.id : null, artifactRefs: [], defects: []
				};
			})
		};
		return route.fulfill({ status: 201, json: matrixRun });
	});
	await page.route('**/api/matrix-runs/matrix-fixture', route => route.fulfill({ json: { run: matrixRun } }));
	await page.route('**/api/profile', route => route.fulfill({
		json: { email: 'fixture@example.test', displayName: 'Fixture owner', profile: { timezone: 'Asia/Kolkata' } }
	}));
	await page.route('**/api/memory*', route => route.fulfill({ json: [] }));
	await page.goto(base);
	// The decorative entry screen is gone — authentication owns the gate now.
	await page.locator('#auth-gate').waitFor({state:'hidden'});
	if (!await page.locator('#qa-start').evaluate(dialog=>dialog.open)) await page.locator('#new-run').click();
	await page.locator('#qa-start[open]').waitFor();
	await page.locator('#qa-matrix-retry').waitFor({ state: 'visible' });
	assert.equal(await page.locator('#qa-submit').isDisabled(), true, 'Catalog failure cannot launch an invented configuration');
	assert.match(await page.locator('#qa-matrix-error-text').textContent(), /temporarily unavailable/i);
	await page.locator('#qa-matrix-retry').click();
	await page.waitForFunction(()=>document.querySelector('#qa-matrix-summary').textContent.includes('1 device · 3 browsers · 3 runs'));
	assert.ok(catalogRequestCount >= 2, 'The launcher catalog can recover through its visible retry action');
	await page.locator('#qa-cancel').click();
	await page.locator('#sidebar-new-run').click();
	await page.locator('#qa-start[open]').waitFor();
	await page.waitForFunction(()=>document.querySelector('#qa-matrix-summary').textContent.includes('1 device · 3 browsers · 3 runs'));
	await page.locator('#qa-cancel').click();
	await page.locator('#new-run').click();
	await page.locator('#qa-start[open]').waitFor();
	await page.waitForFunction(()=>document.querySelector('#qa-matrix-summary').textContent.includes('1 device · 3 browsers · 3 runs'));
	await page.locator('#qa-customize > summary').click();
	const deviceCard = page.locator('.qa-matrix-device').first();
	const deviceSelect = deviceCard.locator('.qa-matrix-device-select');
	assert.equal(await deviceCard.getAttribute('role'), null, 'The device card is informational, not a hidden button');
	assert.equal(await deviceSelect.isVisible(), true, 'The explicit device action is visible when customization is open');
	assert.equal(await deviceSelect.getAttribute('aria-pressed'), 'true');
	assert.equal((await deviceSelect.textContent()).trim(), 'Selected');
	const braveConfiguration = page.locator('.qa-matrix-version input[value="fixture-brave"]');
	await braveConfiguration.evaluate(input => {
		input.checked = false;
		input.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await page.waitForFunction(()=>document.querySelector('#qa-matrix-summary').textContent.includes('1 device · 2 browsers · 2 runs'));
	await deviceCard.locator('.qa-matrix-badge').click();
	await page.waitForFunction(()=>document.querySelector('#qa-matrix-summary').textContent.includes('1 device · 2 browsers · 2 runs'));
	await deviceSelect.click();
	await page.waitForFunction(()=>document.querySelector('#qa-matrix-summary').textContent.includes('1 device · 2 browsers · 2 runs'));
	await page.locator('.qa-matrix-version input[value="fixture-brave"]').evaluate(input => {
		input.checked = true;
		input.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await page.waitForFunction(()=>document.querySelector('#qa-matrix-summary').textContent.includes('1 device · 3 browsers · 3 runs'));
	const setupPageLayout = await page.locator('#qa-start').evaluate(dialog => {
		const rect = dialog.getBoundingClientRect();
		const footer = dialog.querySelector('.modal-foot')?.getBoundingClientRect();
		return {
			width: Math.round(rect.width), height: Math.round(rect.height),
			navVisible: dialog.querySelector('.route-section-nav')?.getBoundingClientRect().width > 0,
			footerReachable: footer && footer.bottom <= window.innerHeight + 1
		};
	});
	assert.ok(setupPageLayout.width >= 1420 && setupPageLayout.height >= 980, 'Test setup fills the viewport');
	assert.equal(setupPageLayout.navVisible, true);
	assert.equal(setupPageLayout.footerReachable, true);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator('[data-page-jump="qa-customize"]').click();
	assert.equal(await page.locator('#qa-customize').evaluate(node => node.open), true, 'Mobile section navigation opens advanced setup');
	assert.ok(await page.locator('#qa-submit').isVisible(), 'The primary setup action remains visible on mobile');
	const mobileDeviceSelect = page.locator('.qa-matrix-device-select').first();
	assert.ok(await mobileDeviceSelect.isVisible(), 'Device selection remains explicit and reachable on mobile');
	await mobileDeviceSelect.scrollIntoViewIfNeeded();
	const mobileDeviceLayout = await mobileDeviceSelect.evaluate(button => {
		const rect = button.getBoundingClientRect();
		const footer = document.querySelector('#qa-start .modal-foot')?.getBoundingClientRect();
		return { left: rect.left, right: rect.right, bottom: rect.bottom, footerTop: footer?.top ?? window.innerHeight };
	});
	assert.ok(mobileDeviceLayout.left >= 0 && mobileDeviceLayout.right <= 390, 'Device selection does not overflow the mobile viewport');
	assert.ok(mobileDeviceLayout.bottom <= mobileDeviceLayout.footerTop, 'Device selection remains above the sticky mobile action bar');
	await screenshot(page, 'start-page-mobile.png');
	await page.setViewportSize({ width: 1440, height: 1000 });
	assert.equal(await page.locator('#qa-submit').isDisabled(),true,'Empty URL cannot launch QA');
	await page.locator('#qa-target-url').fill('https://example.test/');
	assert.equal(await page.locator('#qa-security-auth').isHidden(), true, 'Standard QA does not demand security authorization');
	assert.equal(await page.locator('#qa-submit').isEnabled(),true,'A valid URL enables the standard QA run');
	if (!await page.locator('#qa-customize').evaluate(node => node.open)) {
		await page.locator('#qa-customize > summary').click();
	}
	await page.locator('input[name="qa-test"][value="security_authentication"]').check();
	assert.equal(await page.locator('#qa-submit').isDisabled(), true, 'Opting into security requires authorization');
	await page.locator('#qa-security-authorized').check();
	assert.equal(await page.locator('#qa-submit').isEnabled(), true, 'Authorization resolves the opt-in security gate');
	await page.locator('input[name="qa-test"][value="security_authentication"]').uncheck();
	assert.equal(await page.locator('#qa-security-auth').isHidden(), true, 'Leaving security restores the standard flow');
	await screenshot(page,'start-dialog-ready.png');
	rejectNextMatrixRequest = true;
	await page.locator('#qa-submit').click();
	await page.locator('#qa-form-error').filter({ hasText: 'temporarily unavailable' }).waitFor();
	assert.equal(await page.locator('#qa-start').evaluate(dialog=>dialog.open), true, 'Rejected creation keeps the launcher open');
	assert.equal(await page.locator('#qa-submit').isEnabled(), true, 'Rejected creation restores the primary action');
	const requestsBeforeRetry = matrixRequestCount;
	await page.evaluate(() => {
		const form = document.querySelector('#qa-form');
		const submitter = document.querySelector('#qa-submit');
		form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }));
		form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }));
	});
	await page.locator('#qa-start').waitFor({state:'hidden'});
	assert.equal(matrixRequestCount, requestsBeforeRetry + 1, 'Pending guard prevents duplicate create-run requests');
	assert.deepEqual(matrixRequest.configurationEnvIds, launcherConfigurations.map(row=>row.envId));
	assert.equal(matrixRequest.targetUrl, 'https://example.test/');
	assert.equal(matrixRequest.securityAuthorization, undefined);
	await page.waitForFunction(id => localStorage.getItem('qase.session') === id && document.body.dataset.runStatus === 'running', successfulMatrixSessionId);
	assert.equal(await page.locator('#status-chip').textContent(), 'Running');
	await page.locator('#qa-matrix-run-dialog[open]').waitFor();
	assert.match(await page.locator('#qa-matrix-run-body .qmr-subtitle').textContent(), /Runs one browser at a time/);
	assert.equal(await page.locator('#qa-matrix-run-body .qmr-row').count(), 3, 'Every selected browser is visible on the configuration board');
	assert.equal(await page.locator('#qa-matrix-run-body .qmr-st-running').count(), 1);
	assert.equal(await page.locator('#qa-matrix-run-body .qmr-st-queued').count(), 2);
	await page.locator('#qa-matrix-run-close').click();
	await page.locator('#run-list').filter({ hasText: 'example.test' }).waitFor();
	await screenshot(page,'start-run-success.png');
	const paneResizer = page.locator('#agent-pane-resizer');
	assert.equal(await paneResizer.evaluate(node => getComputedStyle(node).cursor), 'col-resize', 'Panel seam uses the standard resize cursor');
	assert.equal(await paneResizer.locator('button').count(), 0, 'Panel seam has no plus or minus buttons');
	const agentWidthBefore = await page.locator('#workspace-agent').evaluate(node => node.getBoundingClientRect().width);
	const seamBox = await paneResizer.boundingBox();
	assert.ok(seamBox, 'Agent panel resize seam is visible');
	await page.mouse.move(seamBox.x + seamBox.width / 2, seamBox.y + 200);
	await page.mouse.down();
	await page.mouse.move(seamBox.x + seamBox.width / 2 + 36, seamBox.y + 200, { steps: 4 });
	await page.mouse.up();
	const agentWidthAfter = await page.locator('#workspace-agent').evaluate(node => node.getBoundingClientRect().width);
	assert.ok(agentWidthAfter > agentWidthBefore, 'Dragging the seam widens the agent panel');
	checks.push('QA launcher explains disabled states, recovers catalog and backend failures, prevents duplicate creation, selects the created run, and enters the running workspace from both entry points');
	const created = await page.request.post(`${base}/api/sessions`, { data: { selectedTests: ['navigation'], scopeSelection: ['navigation'] } });
	assert.equal(created.status(), 201);
	const {id: qaId} = await created.json();
	const qaSession = sessions.get(qaId);
	await page.request.post(`${base}/api/sessions/${qaId}/message`, { data: { text: targetUrl } });
	await page.evaluate(id => localStorage.setItem('qase.session', id), qaId);
	await page.goto(`${base}/#/runs/${qaId}`);
	await page.locator('#qa-start').evaluate(dialog=>{ if(dialog.open) dialog.close(); });
	await page.waitForFunction(()=>document.querySelector('#chat-title')?.textContent?.includes('127.0.0.1'));
	await page.waitForTimeout(200);
	streams.get(qaSession.id).end();
	qaSession.status = 'awaiting_input';
	qaSession.messages.push({id:randomUUID(),ts:Date.now(),role:'agent',text:'Report progress recovered from the saved session.'});
	await page.waitForFunction(()=>document.querySelector('#status-chip')?.textContent === 'waiting for you');
	await page.getByText('Report progress recovered from the saved session.',{exact:true}).waitFor();
	checks.push('EventSource reconnect reloads state missed during a disconnect');
	await page.locator('#new-sqa').click();await page.locator('#sqa-start[open]').waitFor();
	assert.equal(await page.locator('#sqa-submit').isDisabled(),true);
	await page.locator('#sqa-target-url').fill(targetUrl);
	await page.locator('#sqa-authorization').check();
	await screenshot(page,'sqa-launch.png');
	await page.locator('#sqa-submit').click();await page.locator('#sqa-start').waitFor({state:'hidden'});
	await page.locator('#tab-sqa').waitFor({state:'visible'});await page.locator('#tab-sqa').click();
	assert.ok([...sessions.values()].some(s=>s.mode==='sqa'&&s.sqa.scope.authorization.confirmed));
	checks.push('SQA scope authorization, launcher API, pending assessment panel');
	await page.locator('#new-founder').click();await page.locator('#founder-start[open]').waitFor();
	assert.equal(await page.locator('#founder-customize').evaluate(node => node.open), false);
	await page.locator('#founder-target-url').fill(targetUrl);await page.locator('#founder-authorization').check();
	const founderReadability = await page.locator('.founder-intro').evaluate(node => {
		const strong = getComputedStyle(node.querySelector('strong'));
		const paragraph = getComputedStyle(node.querySelector('p'));
		const reference = document.createElement('span');
		reference.style.color = 'var(--text-secondary)';
		document.body.append(reference);
		const secondaryText = getComputedStyle(reference).color;
		reference.remove();
		return {
			strongUsesPrimaryText: strong.color === getComputedStyle(document.body).color,
			paragraphUsesSecondaryText: paragraph.color === secondaryText,
			strongSize: Number.parseFloat(strong.fontSize),
			paragraphSize: Number.parseFloat(paragraph.fontSize)
		};
	});
	assert.deepEqual(founderReadability, {
		strongUsesPrimaryText: true,
		paragraphUsesSecondaryText: true,
		strongSize: 14,
		paragraphSize: 12.5
	}, 'Founder recommendation uses the readable Studio text hierarchy');
	await screenshot(page,'founder-launch.png');
	await page.locator('#founder-submit').click();await page.locator('#founder-start').waitFor({state:'hidden'});
	await page.locator('#tab-founder').waitFor({state:'visible'});await page.locator('#tab-founder').click();
	assert.ok([...sessions.values()].some(s=>s.mode==='founder'&&s.founder.scope.authorization.confirmed&&s.founder.scope.target.name==='127.0.0.1'));
	checks.push('Founder submits with Advanced options closed and derives the product name from its URL');
	await page.screenshot({path:path.join(output,'desktop.png')});
	for(const width of [768,390]) {
		await page.setViewportSize({width,height:844});
		if (width <= 720) await page.locator('[data-workspace-view="runs"]').click();
		assert.ok(await page.locator('#new-run').isVisible());assert.ok(await page.locator('#new-sqa').isVisible());assert.ok(await page.locator('#new-founder').isVisible());
		await page.locator('#new-sqa').click();await page.locator('#sqa-start[open]').waitFor();
		await screenshot(page,`sqa-${width}.png`);await page.locator('#sqa-cancel').click();
		checks.push(`Mode dock and SQA dialog usable at ${width}px`);
	}
	const completedRun = await services.runs.create('Checkout regression', {
		targetUrl: 'https://shop.example.test/checkout',
		status: 'done',
		completedAt: Date.now(),
		findings: [{
			id: 'finding-results-page',
			title: 'Payment error does not explain the next step',
			severity: 'high', category: 'forms', url: 'https://shop.example.test/checkout',
			impact: 'Customers cannot tell how to recover.',
			expected: 'Explain why payment failed and how to retry.',
			actual: 'A generic error appears with no recovery guidance.',
			steps: ['Open checkout', 'Submit a declined test payment'],
			evidence: 'The error region contains no recovery action.'
		}]
	});
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`${base}/#/runs/${completedRun.id}/results`);
	await page.waitForFunction(() => document.querySelector('#results-page-title')?.textContent === 'Checkout regression'
		&& document.body.dataset.pageLoading !== 'true');
	await page.locator('#results-page-head').waitFor({ state: 'visible' });
	assert.equal(await page.locator('#results-page-title').textContent(), 'Checkout regression');
	assert.equal(await page.locator('#results-page-findings').textContent(), '1 finding');
	assert.equal(await page.locator('#tab-findings').getAttribute('aria-selected'), 'true');
	assert.equal(await page.locator('#tab-activity').isHidden(), true);
	assert.equal(await page.locator('#tab-plan').isHidden(), true);
	assert.equal(await page.locator('#workspace-agent').isHidden(), true);
	assert.ok((await page.locator('#workspace-viewer').boundingBox()).width <= 1182);
	await screenshot(page, 'results-page-desktop.png');
	await page.setViewportSize({ width: 390, height: 844 });
	assert.equal(await page.locator('#results-page-head').isVisible(), true);
	assert.equal(await page.locator('#results-page-new').isVisible(), true);
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
	await screenshot(page, 'results-page-mobile.png');
	await page.locator('#results-page-back').click();
	await page.waitForURL(`**/#/runs/${completedRun.id}`);
	assert.equal(await page.locator('#workspace-agent').isVisible(), true, 'Run workspace returns to the agent view');
	checks.push('Completed runs open a focused results page with evidence, responsive actions, and a working return to the run workspace');
	const blockedRun = await services.runs.create('Restricted checkout', {
		targetUrl: 'https://shop.example.test/restricted',
		status: 'done',
		startedAt: Date.now() - 30_000,
		completedAt: Date.now(),
		report: {
			verdict: 'blocked',
			summary: 'Testing could not proceed past the sign-in screen.',
			covered: [],
			notCovered: ['Checkout: valid test credentials were unavailable.'],
			recommendations: ['Provide a dedicated test account and retry this configuration.']
		}
	});
	await page.goto(`${base}/#/runs/${blockedRun.id}`);
	await page.waitForFunction(() => document.querySelector('#status-chip')?.dataset.status === 'blocked');
	assert.equal(await page.locator('#status-chip').textContent(), 'Blocked');
	assert.equal(await page.locator('#chat-title').textContent(), 'Testing blocked');
	assert.match(await page.locator('#current-activity-state').textContent(), /could not proceed/i);
	assert.equal(await page.locator('#run-timer').getAttribute('data-state'), 'blocked');
	await page.goto(`${base}/#/runs/${blockedRun.id}/results`);
	await page.waitForFunction(() => document.querySelector('#results-page-status')?.dataset.status === 'blocked');
	assert.equal(await page.locator('#results-page-status').textContent(), 'Blocked');
	checks.push('A run that could not test is presented as Blocked throughout the workspace and results page, never as Complete');
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`${base}/#/account`);
	await page.locator('#profile-dialog[open]').waitFor();
	assert.equal(await page.locator('#profile-title').textContent(), 'My account');
	assert.equal(await page.locator('.account-nav').isVisible(), true);
	await screenshot(page, 'account-page-desktop.png');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator('[data-page-jump="account-memory-heading"]').click();
	await page.waitForTimeout(400);
	assert.equal(await page.locator('#account-memory-heading').evaluate(node => document.activeElement === node), true, 'Account section navigation moves keyboard focus');
	assert.equal(await page.locator('#account-memory-heading').evaluate(node => {
		const rect = node.getBoundingClientRect();
		return rect.top >= 0 && rect.bottom <= window.innerHeight;
	}), true, 'Account section navigation reveals its destination');
	assert.ok(await page.locator('#memory-form').isVisible(), 'Saved memory form remains reachable on mobile');
	await screenshot(page, 'account-page-mobile.png');
	await page.locator('#profile-close').click();
	await page.waitForURL('**/#/runs');
	checks.push('Routed Start Testing and My Account pages are full-height, responsive, focus-managed, and return to the workspace');
	assert.equal((await fetch(`${base}/demo`)).status,404);assert.equal((await fetch(`${base}/readyz`)).status,200);
	checks.push('Production demo disabled and readiness reachable');
	// Replay only completed controlled qualification output if available.
	for(const mode of ['qa','sqa','founder']) {
		const candidate = fs.readdirSync('test-results').filter(name=>name.startsWith(`agent-${mode}-`)).map(name=>path.join('test-results',name,'session.json')).filter(file=>fs.existsSync(file)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs).find(file=>JSON.parse(fs.readFileSync(file)).status==='done');
		if(!candidate) continue;
		reportSources[mode] = candidate;
		const s=JSON.parse(fs.readFileSync(candidate));
		// Early qualification outputs predate fixture timestamp initialization.
		s.createdAt ??= s.messages[0]?.ts ?? s.activities[0]?.ts;
		s.updatedAt ??= s.activities.at(-1)?.ts ?? s.createdAt;
		sessions.set(s.id,s);
		const md=await fetch(`${base}/api/sessions/${s.id}/report.md`);assert.equal(md.status,200);assert.ok((await md.text()).length>200);
		const pdf=await fetch(`${base}/api/sessions/${s.id}/report.pdf`);assert.equal(pdf.status,200);assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
		checks.push(`${mode} completed model report exports through real Markdown and PDF HTTP routes`);
	}
	assert.deepEqual(errors,[]);assert.deepEqual([...new Set(turns.map(t=>t.mode))].sort(),['founder','qa','sqa']);
	console.log(JSON.stringify({passed:true,checks,pageErrors:errors,reportSources},null,2));
	fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,pageErrors:errors,reportSources},null,2));
} finally {
	for (const response of streams.values()) {
		if (!response.writableEnded) response.end();
	}
	await settleTeardown(browser.close());
	server.closeAllConnections();
	await settleTeardown(new Promise(resolve=>server.close(resolve)));
}
process.exit(0);
