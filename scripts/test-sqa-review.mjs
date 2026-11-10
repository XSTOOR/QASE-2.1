import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createSqaState, finishSqaAssessment } from '../server/sqaService.js';
import { createTenantContext } from '../server/tenancy.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'test-results', 'sqa-phase-8', `browser-${Date.now()}`);
await mkdir(path.join(directory, '.qase'), { recursive: true });
const session = { id: randomUUID(), title: 'Phase 8 reviewer fixture', mode: 'sqa', status: 'done', ownerUserId: createTenantContext().actorUserId, createdAt: Date.now(), updatedAt: Date.now(), todos: [], findings: [], activities: [], messages: [], secretNames: [] };
session.sqa = createSqaState({ authorizationConfirmed: true, target: { name: 'Controlled review fixture', release: 'phase-8', environment: 'isolated browser test' } });
session.sqa.observations = session.sqa.scope.applicableControlIds.map(controlId => ({ controlId, status: 'blocked', rationale: 'Fixture evidence prerequisite.', evidence: [] }));
await finishSqaAssessment(session, { async commit() {} });
await writeFile(path.join(directory, '.qase', 'sessions.json'), JSON.stringify([session]));
const originalSha = session.sqa.assessment.assessmentSha256;
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
let server;
let log;
async function start() {
	log = createWriteStream(path.join(directory, `server-${Date.now()}.log`));
	server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
		cwd: directory, windowsHide: true,
		env: { ...process.env, NODE_ENV: 'test', PORT: String(port), QASE_HOST: '127.0.0.1', QASE_PUBLIC_URL: base, QASE_AUTH_REQUIRED: 'false', QASE_RUN_STORE: 'local', QASE_EXECUTION_MODE: 'local', QASE_MAIL_MODE: 'mock', QASE_TELEGRAM_ENABLED: 'false', QASE_DRYTIS_INTEGRATION_ENABLED: 'false', QASE_AUTOGEN_ENABLED: 'false' },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	server.stdout.pipe(log, { end: false }); server.stderr.pipe(log, { end: false });
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		if (server.exitCode !== null) throw new Error('Isolated review server exited before readiness.');
		try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* starting */ }
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	throw new Error('Isolated review server did not become ready.');
}
async function stop() {
	if (server && server.exitCode === null) {
		const exited = new Promise(resolve => server.once('exit', resolve));
		server.kill('SIGTERM');
		await Promise.race([exited, new Promise(resolve => { const timer = setTimeout(resolve, 5000); timer.unref(); })]);
	}
	log?.end();
}
let browser;
try {
	await start();
	browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto(`${base}/#/runs/${session.id}`);
	await page.locator('#tab-sqa').click();
	const panel = page.getByRole('region', { name: 'Human evidence review' });
	await panel.getByLabel('Review request or reopening reason').fill('Review the release risk register.');
	await panel.getByRole('button', { name: 'Request review', exact: true }).click();
	await panel.getByText('Review requested', { exact: true }).waitFor();
	await panel.getByText('Review inbox', { exact: true }).click();
	await panel.getByRole('button', { name: 'Refresh review inbox' }).click();
	await panel.getByRole('button', { name: /Phase 8 reviewer fixture/ }).waitFor();
	await panel.getByLabel('Review request or reopening reason').fill('I am reviewing the current release evidence.');
	await panel.getByRole('button', { name: 'Open review draft' }).click();
	await panel.getByText('Review draft — unpublished', { exact: true }).waitFor();
	assert.equal((await page.request.get(`${base}/api/sessions/${session.id}/report.md?version=1`)).status(), 200);
	await panel.getByLabel('Control', { exact: true }).selectOption('SQA-GOV-001');
	await panel.getByLabel('Decision', { exact: true }).selectOption('pass');
	await panel.getByLabel('Reason for this decision').fill('Approved release risk baseline reviewed.');
	await panel.getByLabel('Document reference or URL').fill('artifact://quality/phase-8/risk-register');
	await panel.getByLabel('What this evidence demonstrates').fill('Approved risks and mitigations for this release.');
	await panel.getByRole('button', { name: 'Save control decision' }).click();
	await page.waitForFunction(() => document.querySelector('.sqa-review-form textarea')?.value === 'Approved release risk baseline reviewed.');
	await panel.getByLabel('Publication reason').fill('Risk evidence reviewed. Remaining documentary prerequisites are explicit.');
	await panel.getByRole('button', { name: 'Publish reviewed version' }).click();
	await panel.getByText('Reviewed version published', { exact: true }).waitFor();
	await panel.getByText('Published versions', { exact: true }).click();
	await panel.getByRole('button', { name: 'Load published versions' }).click();
	await panel.getByText(/Version 2 —/).waitFor();
	await panel.getByRole('button', { name: 'Compare with current assessment' }).first().click();
	await panel.getByText('SQA-GOV-001: blocked → pass (evidence changed) (reason changed)', { exact: true }).waitFor();
	await page.screenshot({ path: path.join(directory, 'review-desktop.png'), fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator('[data-workspace-view="results"]').click();
	await page.locator('#tab-sqa').click();
	await panel.scrollIntoViewIfNeeded();
	assert.ok(await panel.evaluate(element => element.scrollWidth - element.clientWidth <= 1), 'Reviewer panel overflows on mobile.');
	await page.screenshot({ path: path.join(directory, 'review-mobile.png'), fullPage: true });
	const final = await (await page.request.get(`${base}/api/sessions/${session.id}`)).json();
	assert.equal(final.sqa.publishedVersions.length, 2);
	assert.equal(final.sqa.publishedVersions[0].assessment.assessmentSha256, originalSha);
	assert.equal(final.sqa.assessment.results.find(item => item.controlId === 'SQA-GOV-001').status, 'pass');
	assert.deepEqual(errors, []);
	await stop(); await start();
	await page.reload();
	const reloaded = await (await page.request.get(`${base}/api/sessions/${session.id}`)).json();
	assert.equal(reloaded.sqa.publishedVersions.length, 2);
	assert.equal(reloaded.sqa.assessment.assessmentSha256, final.sqa.assessment.assessmentSha256);
	const historicalPdf = await page.request.get(`${base}/api/sessions/${session.id}/report.pdf?version=1`);
	assert.equal(historicalPdf.status(), 200);
	assert.ok((await historicalPdf.body()).length > 1000);
	const result = { browserJourney: 'passed', versions: 2, oldVersionPreserved: true, mobileOverflow: false, restartPersistence: 'passed', historicalMarkdown: 'passed', historicalPdf: 'passed', javascriptErrors: errors, modelCalls: 0 };
	await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
	console.log(JSON.stringify({ ...result, directory }, null, 2));
} finally {
	await browser?.close(); await stop();
}
