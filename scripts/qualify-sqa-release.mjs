import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { request } from 'playwright';
import { createSqaTestServer } from './sqa-test-runtime.mjs';
import { SQA_RELEASE_REPORT_CONTROL_IDS } from '../public/sqaEvidencePolicy.js';

// Explicit opt-in: uses a real model, but only against this controlled fixture.
const { values } = parseArgs({ options: {
	'env-file': { type: 'string' }, 'output-dir': { type: 'string' },
	'target-url': { type: 'string' }, 'timeout-minutes': { type: 'string', default: '12' }
} });
assert.ok(values['env-file'], 'Pass --env-file with the existing gateway environment path.');
const timeoutMs = Number(values['timeout-minutes']) * 60_000;
assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 60_000 && timeoutMs <= 900_000, 'Choose a timeout between 1 and 15 minutes.');
const envFile = path.resolve(values['env-file']);
const secrets = Object.entries(parse(await readFile(envFile, 'utf8')))
	.filter(([key, value]) => /key|token|password|secret/i.test(key) && value.length >= 8).map(([, value]) => value);
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.resolve(values['output-dir'] ?? path.join(root, 'test-results', 'sqa-live-release', String(Date.now())));
await mkdir(directory, { recursive: true });
const fixture = createServer((req, res) => {
	res.setHeader('Content-Type', 'text/html; charset=utf-8');
	res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
	if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
	const extra = req.url === '/privacy' ? '<h1>Privacy</h1><p>All validation is local. No accounts, uploads or external requests.</p><a href="/">Back to release fixture</a>' : `
	<header><h1>SQA release fixture</h1><nav aria-label="Main"><a href="/privacy">Privacy</a><a href="#form">Try validation</a></nav></header>
	<main><h2>Account-free local validation</h2><p>This controlled site supports local form validation only.</p>
	<form id="form"><label for="email">Work email</label><input id="email" name="email" type="email" required><button>Validate email</button><output aria-live="polite"></output></form></main>
	<script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('output').textContent='Email format accepted locally. Nothing was sent.'};document.querySelector('input').oninput=()=>document.querySelector('output').textContent='';</script>`;
	res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SQA release fixture</title><style>body{font:18px system-ui;line-height:1.5;max-width:760px;margin:24px auto;padding:0 16px}nav{display:flex;flex-wrap:wrap;gap:16px}input,button{font:inherit;max-width:100%;box-sizing:border-box;padding:8px;margin:8px 0}form{display:grid}a:focus-visible,input:focus-visible,button:focus-visible{outline:3px solid #1455cc}</style></head><body>${extra}</body></html>`);
});
await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
const fixtureTarget = `http://127.0.0.1:${fixture.address().port}/`;
const externalTarget = Boolean(values['target-url']);
const targetUrl = new URL(values['target-url'] || fixtureTarget);
assert.ok(['http:', 'https:'].includes(targetUrl.protocol), 'The qualification target must use HTTP or HTTPS.');
const target = targetUrl.href;
const runtime = await createSqaTestServer(path.join(directory, 'runtime'), { authRequired: true, envFile });
const password = `Controlled qualification ${randomUUID()}`;
const account = { email: `sqa-release-${Date.now()}@local.example`, password, displayName: 'SQA live release qualification' };
let api;
let csrf;
let sessionId;
let finalSession;
const result = {
	status: 'running', startedAt: new Date().toISOString(),
	source: externalTarget ? 'explicitly authorized external SQA target' : 'local controlled SQA release fixture',
	target, modelBacked: true
};
async function json(method, route, data) {
	const response = await api.fetch(`/api${route}`, { method, maxRetries: ['GET', 'HEAD'].includes(method) ? 2 : 0, headers: { Origin: runtime.base, ...(!['GET', 'HEAD'].includes(method) && csrf ? { 'X-CSRF-Token': csrf } : {}) }, ...(data === undefined ? {} : { data }) });
	assert.ok(response.ok(), `${method} ${route} returned HTTP ${response.status()}.`);
	return response.json();
}
async function signIn(register = false) {
	await json('POST', register ? '/auth/register' : '/auth/login', account);
	csrf = (await api.storageState()).cookies.find(cookie => cookie.name === 'qase_csrf')?.value;
	assert.ok(csrf);
}
async function scanSecrets(folder) {
	for (const entry of await readdir(folder, { withFileTypes: true })) {
		const file = path.join(folder, entry.name);
		if (entry.isDirectory()) await scanSecrets(file);
		else if (entry.isFile()) {
			const bytes = await readFile(file);
			assert.ok(!secrets.some(secret => bytes.includes(Buffer.from(secret))), `Configured credential appeared in qualification artifact: ${path.relative(directory, file)}`);
		}
	}
}
try {
	await runtime.start();
	api = await request.newContext({ baseURL: runtime.base, timeout: 30_000 });
	await signIn(true);
	const config = await json('GET', '/config');
	result.provider = config.provider; result.model = config.model;
	const created = await json('POST', '/sqa/sessions', {
		authorizationConfirmed: true, engine: 'chromium', profiles: ['core'], attributes: ['web_application', 'user_interface'],
		target: { name: externalTarget ? targetUrl.hostname : 'SQA release fixture', release: 'sqa-release-candidate-2026-11-06', environment: externalTarget ? 'isolated external qualification' : 'isolated local qualification' },
		scopeNotes: externalTarget
			? 'Public-only authorized target. Do not sign in, submit personal data, create accounts, upload files, make purchases or leave the target origin. Test the six technical browser controls first. Use all four bounded browser_sqa_smoke actions (accessibility, responsive, navigation, form_validation) and diagnostics. Exercise only harmless public interactions. Block unavailable workflows and missing documentary prerequisites honestly.'
			: 'Public-only controlled loopback fixture, no credentials, accounts, payment, media, external services, documents or reviewer evidence. Test the six technical browser controls first. Use all four bounded browser_sqa_smoke actions (accessibility, responsive, navigation, form_validation) and diagnostics. Local form submission changes only the page output. Block missing documentary prerequisites honestly; do not infer them from this sample.'
	});
	sessionId = created.id; assert.equal(created.mode, 'sqa'); assert.notEqual(created.qaExecutionMode, 'hybrid');
	const instruction = externalTarget
		? `${target} Run this explicitly authorized public-only SQA release qualification. Verify initial rendering, safe public navigation and return, any harmless visible form validation without submitting data, keyboard/semantics, narrow-screen layout and diagnostics. Use browser_sqa_smoke for all four actions. Finish all six SQA-WEB technical controls with observed evidence or a precise target-specific blocker. Batch missing reviewer-only documents as blocked, complete the host plan and publish finish_sqa_assessment. There are no credentials or documents to request. Do not sign in, create an account, upload, purchase, leave the target origin or submit personal data.`
		: `${target} Run this explicitly authorized public-only SQA release qualification. Verify initial rendering, navigation to Privacy and back, native invalid/valid email behavior, keyboard/semantics, narrow-screen layout and diagnostics. Use run_sqa_smoke_workflow with workflow=presentation, review and batch-record its four controls, then workflow=interaction with links=["Privacy"] and batch-record its two controls. These compositions execute all four browser_sqa_smoke actions with individually saved and budget-counted children; do not repeat them as separate tools. Finish all six SQA-WEB technical controls with observed evidence. Continue other scoped work only where this fixture supplies an oracle; block unsupported assurance claims honestly. Complete the host plan and publish finish_sqa_assessment. There are no credentials or documents to request. Do not expand into media, checkout, outside origins or an account workflow.`;
	await json('POST', `/sessions/${sessionId}/message`, { text: instruction });
	const started = Date.now();
	let progress;
	while (Date.now() - started < timeoutMs) {
		const current = await json('GET', `/sessions/${sessionId}`);
		const next = JSON.stringify({ status: current.status, observations: current.sqa?.observations?.length ?? 0, activities: current.activities?.length ?? 0, inputTokens: current.tokenUsage?.inputTokens ?? 0, finalized: Boolean(current.sqa?.finalizedAt) });
		if (progress !== next) { console.log(next); progress = next; }
		assert.ok((current.tokenUsage?.inputTokens ?? 0) <= 550_000, 'Qualification exceeded its input-token acceptance ceiling.');
		if (current.pendingQuestion) throw new Error('Live SQA unexpectedly requires clarification for the declared account-free fixture.');
		if (current.sqa?.finalizedAt && current.status === 'done' && !current.running) { finalSession = current; break; }
		if (['error', 'interrupted', 'awaiting_input'].includes(current.status) && !current.running) throw new Error(`Live SQA ended as ${current.status}.`);
		await new Promise(resolve => setTimeout(resolve, 2000));
	}
	assert.ok(finalSession, 'Live SQA did not finalize within the configured deadline.');
	const assessment = finalSession.sqa.assessment;
	assert.equal(finalSession.mode, 'sqa'); assert.notEqual(finalSession.qaExecutionMode, 'hybrid');
	assert.equal(assessment.results.length, finalSession.sqa.scope.applicableControlIds.length);
	assert.ok(assessment.results.every(item => item.status !== 'not_assessed'));
	assert.equal(assessment.verdict, 'blocked', 'Missing reviewer documents must keep this browser-only assessment blocked.');
	const technical = assessment.results.filter(item => /^SQA-WEB-00[1-6]$/.test(item.controlId));
	assert.equal(technical.length, 6);
	if (externalTarget) assert.ok(technical.every(item => item.status !== 'not_assessed'), 'An external-target technical control was not assessed.');
	else assert.ok(technical.every(item => item.status === 'pass'), 'A healthy fixture technical control did not pass; inspect the retained session.');
	if (!externalTarget) for (const id of SQA_RELEASE_REPORT_CONTROL_IDS) {
		const control = assessment.results.find(item => item.controlId === id);
		assert.equal(control?.status, 'blocked', `${id}: a browser-only fixture cannot supply a full reviewed release report.`);
		assert.ok(control.evidenceCoverage.requirements.every(item => !item.satisfied && item.owner === 'reviewer'), `${id}: partial browser activity must not hide a missing release report.`);
	}
	result.releaseReportBoundary = externalTarget ? 'not asserted for external artifacts' : 'passed';
	const activities = finalSession.activities.filter(item => item.status === 'done' && item.toolName?.startsWith('browser_'));
	const workflowActivities = finalSession.activities.filter(item => item.toolName === 'run_sqa_smoke_workflow');
	result.smokeWorkflows = {
		attempts: workflowActivities.length,
		completed: workflowActivities.filter(item => item.status === 'done').map(item => item.input?.workflow),
		childSmokeActions: activities.filter(item => item.toolName === 'browser_sqa_smoke').map(item => item.input?.action),
		uncomposedInputActions: activities.filter(item => ['browser_fill', 'browser_click', 'browser_type', 'browser_key', 'browser_select', 'browser_check'].includes(item.toolName)).length
	};
	if (!externalTarget && !finalSession.sqa.execution) {
		assert.deepEqual([...result.smokeWorkflows.completed].sort(), ['interaction', 'presentation'], 'The controlled live qualification must exercise each preferred composition exactly once.');
		assert.deepEqual([...result.smokeWorkflows.childSmokeActions].sort(), ['accessibility', 'form_validation', 'navigation', 'responsive'], 'The healthy controlled fixture must not repeat completed smoke checks.');
	}
	for (const action of ['accessibility', 'responsive', 'navigation', 'form_validation']) {
		const completed = activities.some(item => item.toolName === 'browser_sqa_smoke' && item.input?.action === action);
		if (externalTarget && action === 'form_validation' && !completed) {
			const formControl = technical.find(item => item.controlId === 'SQA-WEB-003');
			assert.equal(formControl?.status, 'blocked', 'A missing external form smoke must produce a precise blocked form control.');
			assert.match(formControl?.rationale ?? '', /\b(?:no|none|absent|requires?|could not|unsupported)\b.*\b(?:form|field|validation)\b|\b(?:form|field|validation)\b.*\b(?:no|none|absent|requires?|could not|unsupported)\b/i,
				'The external form blocker does not explain why the bounded smoke was unavailable.');
			continue;
		}
		assert.ok(completed, `Missing ${action} smoke activity.`);
	}
	assert.ok(finalSession.tokenUsage?.totalTokens > 0, 'The live run must retain model usage.');
	let evidenceCount = 0;
	for (const control of assessment.results) {
		if (control.status === 'pass') assert.deepEqual(control.evidenceCoverage.missing, []);
		for (let index = 1; index <= (control.evidence?.length ?? 0); index++) {
			const evidence = await json('GET', `/sessions/${sessionId}/sqa/evidence/${control.controlId}/${index}`);
			assert.equal(evidence.integrity, 'verified'); evidenceCount++;
		}
	}
	assert.ok(evidenceCount > 0);
	for (const extension of ['md', 'pdf']) {
		const response = await api.get(`/api/sessions/${sessionId}/report.${extension}?version=1`);
		assert.equal(response.status(), 200); const bytes = await response.body(); assert.ok(bytes.length > 1000);
		await writeFile(path.join(directory, `assessment.${extension}`), bytes);
	}
	await writeFile(path.join(directory, 'session.json'), JSON.stringify(finalSession, null, 2));
	const stranger = await request.newContext({ baseURL: runtime.base });
	try {
		assert.equal((await stranger.post('/api/auth/register', { data: { ...account, email: `other-${Date.now()}@local.example` } })).status(), 201);
		for (const route of [`/sessions/${sessionId}`, `/sessions/${sessionId}/report.md`, `/sessions/${sessionId}/sqa/evidence/${technical[0].controlId}/1`]) assert.equal((await stranger.get(`/api${route}`)).status(), 404, 'Another account gained access to this run.');
	} finally { await stranger.dispose(); }
	await runtime.stop(); await runtime.start();
	await signIn();
	const reloaded = await json('GET', `/sessions/${sessionId}`);
	assert.equal(reloaded.sqa.assessment.assessmentSha256, assessment.assessmentSha256);
	assert.equal((await json('GET', `/sessions/${sessionId}/sqa/evidence/${technical[0].controlId}/1?version=1`)).integrity, 'verified');
	for (const extension of ['md', 'pdf']) assert.equal((await api.get(`/api/sessions/${sessionId}/report.${extension}?version=1`)).status(), 200);
	Object.assign(result, { status: 'passed', sessionId, assessmentId: assessment.assessmentId, assessmentSha256: assessment.assessmentSha256, counts: assessment.summary, technicalSummary: assessment.technicalSummary, evidenceVerified: evidenceCount, browserActivities: activities.length, tokenUsage: finalSession.tokenUsage, historicalExports: 'passed', restartPersistence: 'passed', crossAccountIsolation: 'passed', hybridIsolation: 'passed' });
} catch (error) {
	result.status = 'failed'; result.error = error.message; result.sessionId = sessionId; process.exitCode = 1;
	if (sessionId && api) {
		await json('POST', `/sessions/${sessionId}/stop`).catch(() => undefined);
		const stopped = await json('GET', `/sessions/${sessionId}`).catch(() => undefined);
		if (stopped) await writeFile(path.join(directory, 'session.json'), JSON.stringify(stopped, null, 2));
	}
} finally {
	await api?.dispose(); await runtime.stop();
	fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
	result.finishedAt = new Date().toISOString();
	await writeFile(path.join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
	try { await scanSecrets(directory); result.credentialScan = 'passed'; }
	catch (error) { result.status = 'failed'; result.credentialScan = 'failed'; result.error = error.message; process.exitCode = 1; }
	await writeFile(path.join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
	console.log(JSON.stringify({ ...result, directory }, null, 2));
}
