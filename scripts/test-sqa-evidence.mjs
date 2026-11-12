import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSqaTestBrowser, createSqaTestServer, launchSqaTestBrowser } from './sqa-test-runtime.mjs';
import { createSqaState, finishSqaAssessment, recordAgentSqaObservation } from '../server/sqaService.js';
import { getSqaControl, SQA_TECHNICAL_CONTROL_IDS } from '../server/sqaCatalog.js';
import { createTenantContext } from '../server/tenancy.js';
import { seedSqaSmokePassReceipts } from './fixtures/sqa-smoke.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { browser: { type: 'string', default: 'chromium' }, 'output-dir': { type: 'string' } } });
const browserName = assertSqaTestBrowser(values.browser);
const directory = path.resolve(values['output-dir'] ?? path.join(root, 'test-results', 'sqa-phase-9', `${browserName}-${Date.now()}`));
await mkdir(path.join(directory, '.qase'), { recursive: true });
const session = { id: randomUUID(), title: 'Phase 9 evidence fixture', mode: 'sqa', status: 'done', ownerUserId: createTenantContext().actorUserId, createdAt: Date.now(), updatedAt: Date.now(), todos: [], findings: [], activities: [{ id: 'fixture-observation', toolName: 'browser_snapshot', status: 'done', ts: Date.now(), summary: 'Synthetic observation used solely to test evidence transport and report rendering.' }], messages: [], secretNames: [] };
session.sqa = createSqaState({ authorizationConfirmed: true, target: { name: 'Controlled evidence fixture', release: 'phase-9', environment: 'isolated browser test' } });
session.sqa.observations = session.sqa.scope.applicableControlIds.map(controlId => ({ controlId, status: 'blocked', rationale: 'Fixture evidence prerequisite.', evidence: [] }));
await seedSqaSmokePassReceipts(session);
for (const controlId of SQA_TECHNICAL_CONTROL_IDS) {
	await recordAgentSqaObservation(session, { control_id: controlId, status: 'pass', evidence: getSqaControl(controlId).evidenceRequirements.flatMap(requirement => Array.from({ length: requirement.minimum }, () => ({ type: requirement.type, summary: `Synthetic ${controlId} rendering fixture; no product behavior is claimed. <script>window.evidenceInjection = true</script>` }))) }, { async commit() {} });
}
const reviewControl = 'SQA-QUA-005';
await recordAgentSqaObservation(session, {
	control_id: reviewControl, status: 'blocked', rationale: 'The restoration record is required.',
	evidence_type: 'test_result', evidence_summary: 'Controlled browser recovery sample.'
}, { async commit() {} });
const originalBrowserEvidence = session.sqa.observations.find(item => item.controlId === reviewControl).evidence[0];
// Explicit negative fixtures: unavailable legacy bundle and tampered retained bytes.
const legacyDigest = session.sqa.observations.find(item => item.controlId === 'SQA-WEB-002').evidence[0].digest;
delete session.sqa.evidenceRecords[legacyDigest];
const tamperedDigest = session.sqa.observations.find(item => item.controlId === 'SQA-WEB-003').evidence[0].digest;
session.sqa.evidenceRecords[tamperedDigest].summary = 'Deliberately tampered test fixture.';
await finishSqaAssessment(session, { async commit() {} });
await writeFile(path.join(directory, '.qase', 'sessions.json'), JSON.stringify([session]));
const originalSha = session.sqa.assessment.assessmentSha256;
const { base, start, stop } = await createSqaTestServer(directory);
let browser;
try {
	await start();
	browser = await launchSqaTestBrowser(browserName);
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	let modelRequests = 0;
	await page.route('**/api/sessions/*/message', async route => {
		modelRequests++;
		await route.fulfill({ status: 503, json: { error: 'Model turns are disabled in evidence acceptance.' } });
	});
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto(`${base}/#/runs/${session.id}/results`);
	await page.waitForFunction(title => document.body.dataset.page === 'results' && !document.body.dataset.pageLoading
		&& document.getElementById('results-page-title').title === title, session.title);
	await page.locator('#tab-sqa').click();
	const view = page.locator('#sqa-view');
	const assertOutcome = async container => {
		const overview = container.locator('.sqa-outcome-split');
		try {
			await overview.getByRole('heading', { name: 'Browser checks', exact: true }).waitFor({ timeout: 5000 });
		} catch (error) {
			await page.screenshot({ path: path.join(directory, 'sqa-outcome-failure.png') });
			throw new Error(`SQA overview heading was unavailable. Page errors: ${errors.join('; ') || 'none'}.`, { cause: error });
		}
		await overview.getByText('The automated web checks all passed.', { exact: true }).waitFor();
		await overview.getByRole('heading', { name: 'Reviewer evidence', exact: true }).waitFor();
		await overview.getByText(/controls need evidence from a reviewer\./).waitFor();
		const target = container.locator('.sqa-unresolved-group[data-kind="reviewer"]');
		const evidence = target.locator('.sqa-unresolved').filter({ hasText: 'SQA-GOV-001' }).getByRole('list', { name: 'Missing evidence' });
		await evidence.getByText('Risk Register', { exact: true }).waitFor();
		await evidence.getByText(/Reviewer evidence \(0 of 1 supplied\)/).waitFor();
		const action = overview.getByRole('button', { name: 'View required evidence', exact: true });
		await action.focus();
		await page.keyboard.press('Enter');
		assert.equal(await target.evaluate(element => document.activeElement === element), true);
		return overview;
	};
	const overview = await assertOutcome(view);
	await overview.screenshot({ path: path.join(directory, 'sqa-outcomes-desktop.png') });
	await page.locator('#tab-report').click();
	await assertOutcome(page.locator('#report-view'));
	await page.locator('#tab-sqa').click();
	assert.equal(await view.evaluate(element => Boolean(element.querySelector('.sqa-technical').compareDocumentPosition(element.querySelector('.sqa-review-panel')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
	for (const [controlId, label] of [['SQA-WEB-001', 'Digest verified'], ['SQA-WEB-002', 'Original bundle unavailable'], ['SQA-WEB-003', 'Digest mismatch']]) {
		const control = view.locator('.sqa-control').filter({ has: page.locator('summary code', { hasText: controlId }) });
		await control.locator('summary').click();
		await control.getByRole('button', { name: `Inspect evidence 1 for ${controlId}`, exact: true }).click();
		const dialog = page.getByRole('dialog', { name: `Evidence 1 for ${controlId}`, exact: true });
		await dialog.getByText(label, { exact: true }).waitFor();
		await dialog.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
		assert.equal(await page.evaluate(() => Boolean(window.evidenceInjection)), false);
		if (controlId === 'SQA-WEB-001') await page.screenshot({ path: path.join(directory, 'evidence-inspector.png'), fullPage: true });
		await dialog.getByRole('button', { name: 'Close evidence' }).click();
	}
	const panel = page.getByRole('region', { name: 'Human evidence review' });
	await panel.getByLabel('Review request or reopening reason').fill('Review the release risk register.');
	await panel.getByRole('button', { name: 'Request review', exact: true }).click();
	await panel.getByText('Review requested', { exact: true }).waitFor();
	await panel.getByText('Review inbox', { exact: true }).click();
	await panel.getByRole('button', { name: 'Refresh review inbox' }).click();
	await panel.getByRole('button', { name: /Phase 9 evidence fixture/ }).waitFor();
	await page.locator('#tab-report').click();
	await page.locator('#report-view').getByRole('button', { name: `Review evidence for ${reviewControl}`, exact: true }).click();
	assert.equal(await panel.getByLabel('Review request or reopening reason').evaluate(element => element === document.activeElement), true);
	await panel.getByLabel('Review request or reopening reason').fill('I am reviewing the current release evidence.');
	await panel.getByRole('button', { name: 'Open review draft' }).click();
	await panel.getByText('Review draft — unpublished', { exact: true }).waitFor();
	assert.equal((await page.request.get(`${base}/api/sessions/${session.id}/report.md?version=1`)).status(), 200);
	assert.equal(await panel.getByLabel('Control', { exact: true }).inputValue(), reviewControl);
	await panel.getByText('1 browser evidence record will be kept with this decision.', { exact: true }).waitFor();
	assert.equal(await panel.getByLabel('Document reference or URL').count(), 1);
	await panel.getByLabel('Decision', { exact: true }).selectOption('pass');
	await panel.getByLabel('Reason for this decision').fill('The restoration evidence was reviewed.');
	await panel.getByLabel('Document reference or URL').fill('artifact://quality/phase-9/restore-proof');
	await panel.getByLabel('What this evidence demonstrates').fill('Reviewed restoration outcome for this release.');
	await panel.locator('.sqa-review-evidence').screenshot({ path: path.join(directory, 'review-evidence-editor.png') });
	let releaseDuplicate;
	const duplicateRelease = new Promise(resolve => { releaseDuplicate = resolve; });
	await page.route(`${base}/api/sessions/${session.id}`, async route => {
		const response = await route.fetch();
		const snapshot = await response.json();
		if (snapshot.sqa?.reviewRevision === 3) await duplicateRelease;
		await route.fulfill({ response });
	});
	await panel.getByRole('button', { name: 'Save control decision' }).click();
	await page.waitForFunction(() => document.querySelector('.sqa-review-panel')?.dataset.reviewRevision === '3');
	await panel.getByLabel('Publication reason').fill('Restoration evidence reviewed. Remaining prerequisites are explicit.');
	releaseDuplicate();
	await page.unrouteAll({ behavior: 'wait' });
	assert.equal(await panel.getByLabel('Publication reason').inputValue(), 'Restoration evidence reviewed. Remaining prerequisites are explicit.');
	await panel.getByRole('button', { name: 'Publish reviewed version' }).click();
	await panel.getByText('Reviewed version published', { exact: true }).waitFor();
	const inspectedDocument = await (await page.request.get(`${base}/api/sessions/${session.id}/sqa/evidence/${reviewControl}/2`)).json();
	assert.equal(inspectedDocument.integrity, 'external_unverified');
	const retainedBrowserEvidence = await (await page.request.get(`${base}/api/sessions/${session.id}/sqa/evidence/${reviewControl}/1`)).json();
	assert.equal(retainedBrowserEvidence.integrity, 'verified');
	await panel.getByText('Published versions', { exact: true }).click();
	await panel.getByRole('button', { name: 'Load published versions' }).click();
	await panel.getByText(/Version 2 —/).waitFor();
	await panel.getByRole('button', { name: 'Compare with current assessment' }).first().click();
	await panel.getByText(`${reviewControl}: blocked → pass (evidence changed) (reason changed)`, { exact: true }).waitFor();
	await page.screenshot({ path: path.join(directory, 'review-desktop.png'), fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator('#tab-sqa').click();
	assert.ok(await overview.evaluate(element => element.scrollWidth - element.clientWidth <= 1), 'Outcome summary overflows on mobile.');
	await overview.screenshot({ path: path.join(directory, 'sqa-outcomes-mobile.png') });
	await panel.scrollIntoViewIfNeeded();
	assert.ok(await panel.evaluate(element => element.scrollWidth - element.clientWidth <= 1), 'Reviewer panel overflows on mobile.');
	await view.locator('.sqa-control').filter({ has: page.locator('summary code', { hasText: 'SQA-WEB-001' }) }).locator('summary').click();
	await view.getByRole('button', { name: 'Inspect evidence 1 for SQA-WEB-001', exact: true }).first().click();
	const mobileInspector = page.getByRole('dialog', { name: 'Evidence 1 for SQA-WEB-001', exact: true });
	await mobileInspector.getByText('Digest verified', { exact: true }).waitFor();
	await mobileInspector.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
	assert.ok(await mobileInspector.evaluate(element => element.scrollWidth - element.clientWidth <= 1), 'Evidence inspector overflows on mobile.');
	await page.screenshot({ path: path.join(directory, 'inspector-mobile.png'), fullPage: true });
	await mobileInspector.getByRole('button', { name: 'Close evidence' }).click();
	await page.screenshot({ path: path.join(directory, 'review-mobile.png'), fullPage: true });
	const final = await (await page.request.get(`${base}/api/sessions/${session.id}`)).json();
	assert.equal(final.sqa.publishedVersions.length, 2);
	assert.equal(final.sqa.publishedVersions[0].assessment.assessmentSha256, originalSha);
	const reviewed = final.sqa.assessment.results.find(item => item.controlId === reviewControl);
	assert.equal(reviewed.status, 'pass');
	assert.deepEqual(reviewed.evidence[0], originalBrowserEvidence);
	assert.deepEqual(errors, []);
	await stop(); await start();
	await page.reload();
	const reloaded = await (await page.request.get(`${base}/api/sessions/${session.id}`)).json();
	assert.equal(reloaded.sqa.publishedVersions.length, 2);
	assert.equal(reloaded.sqa.assessment.assessmentSha256, final.sqa.assessment.assessmentSha256);
	const persistedEvidence = await (await page.request.get(`${base}/api/sessions/${session.id}/sqa/evidence/SQA-WEB-001/1?version=1`)).json();
	assert.equal(persistedEvidence.integrity, 'verified');
	const historicalPdf = await page.request.get(`${base}/api/sessions/${session.id}/report.pdf?version=1`);
	assert.equal(historicalPdf.status(), 200);
	assert.ok((await historicalPdf.body()).length > 1000);
	await writeFile(path.join(directory, 'assessment.pdf'), await historicalPdf.body());
	assert.equal(modelRequests, 0);
	const result = { browser: browserName, browserVersion: browser.version(), browserJourney: 'passed', versions: 2, oldVersionPreserved: true, evidenceStates: ['verified', 'unavailable', 'mismatch', 'external_unverified'], injectionPrevented: true, mobileOverflow: false, restartPersistence: 'passed', historicalMarkdown: 'passed', historicalPdf: 'passed', javascriptErrors: errors, modelCalls: modelRequests };
	await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
	console.log(JSON.stringify({ ...result, directory }, null, 2));
} finally {
	await browser?.close(); await stop();
}
