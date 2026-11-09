import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isolatedSqaEnvironment } from '../scripts/sqa-test-runtime.mjs';

const fixtureTests = [
	'app.test.js', 'catalogApi.test.js', 'drytisTickets.test.js',
	'environmentApi.test.js', 'feedbackAnalytics.test.js', 'feedbackNotifyApi.test.js',
	'founderHandoffApi.test.js', 'localServices.test.js', 'matrixApi.test.js',
	'pilotFlow.test.js', 'runTimingApi.test.js', 'securityRegression.test.js',
	'telegramNotificationApi.test.js', 'telegramWebhook.test.js', 'testCaseApi.test.js',
	'agent.test.js', 'attestation.test.js', 'founderEvidence.test.js', 'founderService.test.js',
	'hybridArchitecture.test.js', 'hybridAuth.browser.test.js', 'hybridAuth.integration.test.js',
	'hybridAuth.test.js', 'jevReportEvidence.test.js', 'qaTools.test.js', 'sqaEvidence.test.js',
	'sqaReview.test.js', 'sqaService.test.js', 'serviceFactory.test.js', 'testCaseAutogen.integration.test.js'
].map(name => fileURLToPath(new URL(name, import.meta.url)));

function checksums(directory) {
	const result = {};
	function visit(relative) {
		const file = path.join(directory, relative);
		if (fs.statSync(file).isDirectory()) {
			for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
		} else result[relative] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
	}
	visit('');
	return result;
}

test('application fixtures preserve caller data and create no credentials, snapshots or artifacts', { timeout: 120_000 }, t => {
	const temporaryRoot = fs.realpathSync(os.tmpdir());
	const caller = fs.mkdtempSync(path.join(temporaryRoot, 'qase-isolation-sentinel-'));
	t.after(() => {
		assert.equal(path.dirname(caller), temporaryRoot);
		assert.ok(path.basename(caller).startsWith('qase-isolation-sentinel-'));
		fs.rmSync(caller, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
	const fixtures = {
		'.env': 'QASE_ISOLATION_SENTINEL=preserve-this-file\n',
		'.qase/feedback.json': JSON.stringify([{ id: 'cf9a4d44-292c-4260-a9df-3dca693ae054', runId: '25f2905e-e3ec-44e1-b3c8-9444e8e2f941', submittedBy: 'sentinel-owner', rating: 5, category: 'overall', status: 'new', submittedAt: 1 }]),
		'.qase/analytics/analytics.json': JSON.stringify({ schemaVersion: 1, events: [] }),
		'.qase/sessions.json': '[]'
	};
	for (const [relative, content] of Object.entries(fixtures)) {
		fs.mkdirSync(path.dirname(path.join(caller, relative)), { recursive: true });
		fs.writeFileSync(path.join(caller, relative), content);
	}
	const before = checksums(caller);
	const options = { cwd: caller, env: isolatedSqaEnvironment(), encoding: 'utf8', timeout: 100_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true };

	// Reproduce the old writes only inside disposable sentinel data. This
	// negative control proves that the data-preservation check detects them.
	const control = spawnSync(process.execPath, ['--input-type=module', '-e', `
		import path from 'node:path';
		import { recordEvent } from ${JSON.stringify(new URL('./analytics.js', import.meta.url).href)};
		import { createFeedback } from ${JSON.stringify(new URL('./feedbackStore.js', import.meta.url).href)};
		recordEvent(path.join(process.cwd(), '.qase', 'analytics'), 'isolation_control');
		createFeedback({ runId: '630f4f5b-dc04-45b2-b49c-3c4e10c62ad9', submittedBy: 'controlled-fixture', rating: 4 });
	`], options);
	assert.equal(control.status, 0, control.stderr || control.error?.message);
	const afterControl = checksums(caller);
	const detected = Object.keys(before).filter(name => afterControl[name] !== before[name]).sort();
	assert.deepEqual(detected, [path.join('.qase', 'analytics', 'analytics.json'), path.join('.qase', 'feedback.json')].sort());
	for (const [relative, content] of Object.entries(fixtures)) fs.writeFileSync(path.join(caller, relative), content);
	assert.deepEqual(checksums(caller), before);

	const run = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...fixtureTests], options);
	assert.equal(run.status, 0, `${run.error?.message ?? ''}\n${run.stderr}\n${run.stdout}`);
	assert.deepEqual(checksums(caller), before, 'Application fixtures must not change or add files in the caller directory.');
});
