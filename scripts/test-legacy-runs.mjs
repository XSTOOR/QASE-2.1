#!/usr/bin/env node
/**
 * Runs saved by earlier QASE versions (pre-rebuild SQA state, version-1 QA
 * state, pre-rebuild Founder state) must still open: the run API, Markdown and
 * PDF reports answer, and the dashboard renders them without page errors.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'playwright';

const { createSqaTestServer, launchSqaTestBrowser } = await import('./sqa-test-runtime.mjs');
const dir = path.join('/tmp', `legacy-${Date.now()}`);
const runtime = await createSqaTestServer(dir, { authRequired: true });
await runtime.start();
const api = await request.newContext({ baseURL: runtime.base });
const email = `legacy-${randomUUID()}@example.test`;
const password = `Legacy runs ${randomUUID()}`;
const user = await (await api.post('/api/auth/register', { data: { email, displayName: 'Legacy', password } })).json();
const owner = user.id ?? user.user?.id;
assert.ok(owner);
const now = Date.now();
const finding = { id: randomUUID(), ts: now, title: 'Legacy finding', severity: 'medium', category: 'privacy', status: 'open', actual: 'x', expected: 'y', steps: ['Open /'] };
const legacy = [
	{ id: randomUUID(), mode: 'sqa', title: 'Compliance (old format)', targetUrl: 'https://old.example/', status: 'done', createdAt: now - 9e6, updatedAt: now - 9e6, ownerUserId: owner, todos: [], activities: [], messages: [{ id: 'a', role: 'agent', text: 'Old compliance run.' }], findings: [finding],
		sqa: { scope: { profiles: ['gdpr', 'wcag'] }, status: 'done', assessments: [{ profile: 'gdpr', verdict: 'partial' }] }, report: { verdict: 'pass_with_issues', summary: 'Old SQA summary.' } },
	{ id: randomUUID(), mode: 'qa', title: 'QA (version 1 state)', targetUrl: 'https://old.example/', status: 'done', createdAt: now - 8e6, updatedAt: now - 8e6, ownerUserId: owner, todos: [], activities: [], messages: [], findings: [finding],
		hybrid: { version: 1, status: 'done', phases: [{ id: 'crawl', status: 'done' }] }, report: { verdict: 'fail', summary: 'Old QA summary.' } },
	{ id: randomUUID(), mode: 'founder', title: 'Founder (old format)', targetUrl: 'https://old.example/', status: 'done', createdAt: now - 7e6, updatedAt: now - 7e6, ownerUserId: owner, todos: [], activities: [], messages: [], findings: [],
		founder: { version: 1, scope: { target: 'https://old.example/' }, observations: [{ id: 'obs-1', url: 'https://old.example/', note: 'Pricing page exists.' }], finalizedAt: new Date(now - 7e6).toISOString(), updatedAt: new Date(now - 7e6).toISOString(),
			// Shape written by the pre-rebuild Founder pipeline (server/founderSchema.js normalizeFounderReport).
			report: { generatedAt: new Date(now - 7e6).toISOString(), target: 'https://old.example/',
				icp: { primary: 'Small agencies', users: ['Project managers'], buyers: ['Agency owners'], jobs: ['Track client work'], pains: ['Missed deadlines'], evidenceObservationIds: ['obs-1'], assumptions: [] },
				positioning: { category: 'Project management', oneLiner: 'Client work, on time.', valueProposition: 'Fewer missed deadlines.', differentiators: ['Client portal'], alternatives: ['Spreadsheets'], evidenceObservationIds: ['obs-1'], assumptions: [] } } },
		report: { verdict: 'needs_work', summary: 'Old founder summary.' } }
];
await runtime.stop();
await fs.writeFile(path.join(dir, '.qase', 'sessions.json'), JSON.stringify(legacy));
await runtime.start();
const signedIn = await request.newContext({ baseURL: runtime.base });
assert.equal((await signedIn.post('/api/auth/login', { data: { email, password } })).status(), 200);
const results = [];
for (const run of legacy) {
	for (const suffix of ['', '/report.md', '/report.pdf', '/qa-evidence', '/artifacts']) {
		const response = await signedIn.get(`/api/sessions/${run.id}${suffix}`);
		results.push(`${response.status()} ${run.mode.padEnd(8)} GET /api/sessions/:id${suffix}`);
		assert.ok(response.status() < 500, `${run.mode} ${suffix || '/'} answered ${response.status()}`);
		if (!suffix) assert.equal(response.status(), 200);
		if (suffix === '/report.md') assert.equal(response.status(), 200, `${run.mode} markdown report`);
	}
}
// Render each run in the dashboard: no uncaught page errors.
const browser = await launchSqaTestBrowser('chromium');
const context = await browser.newContext({ storageState: await signedIn.storageState() });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.goto(runtime.base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.body.dataset.page && !document.body.dataset.pageLoading, null, { timeout: 20000 }).catch(() => {});
for (const run of legacy) {
	const entry = page.locator('.run, [data-run-id], .run-card').filter({ hasText: /old\.example/ }).nth(legacy.indexOf(run));
	const opened = await entry.click({ timeout: 8000 }).then(() => true).catch(() => false);
	results.push(`open    ${run.mode.padEnd(8)} ${opened ? 'opened from the sidebar' : 'NOT FOUND in the sidebar'}`);
	assert.ok(opened, `${run.mode} old run is listed and opens`);
	await page.waitForTimeout(2500);
	for (const tab of ['Plan', 'Activity', 'Findings', 'Results', 'Report']) {
		const button = page.getByRole('tab', { name: new RegExp(`^${tab}`, 'i') }).first();
		if (await button.count()) { await button.click().catch(() => {}); await page.waitForTimeout(400); }
	}
	results.push(`render  ${run.mode.padEnd(8)} page errors so far: ${errors.length}`);
}
await browser.close();
await runtime.stop();
for (const line of results) console.log(line);
assert.deepEqual(errors, [], `page errors while rendering old runs: ${errors.join(' | ')}`);
console.log(JSON.stringify({ ok: true, runs: legacy.length }));
