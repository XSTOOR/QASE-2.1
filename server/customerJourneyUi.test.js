import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static contract tests for the Phase-5 customer-journey affordances: config
 * gating, demo-site discovery, concise empty state, resume affordance, and SQA
 * export parity. These read the dashboard sources as text so regressions in
 * markup or wiring fail the suite without a browser.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '../public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(here, '../public/app.js'), 'utf8');

test('all three launchers gate on model readiness before creating a session', () => {
	const launcherGates = appJs.match(/ensureModelConfigured\('(?:QA|SQA|Founder) launcher'\)/g) ?? [];
	assert.equal(launcherGates.length, 3, 'QA, SQA, and Founder submits must all call ensureModelConfigured');
});

test('demo site is discoverable from the launcher and the empty state', () => {
	assert.match(html, /id="qa-demo-fill"/, 'launcher demo fill button');
	assert.match(html, /id="empty-demo"/, 'empty-state demo CTA');
	assert.match(appJs, /demoSiteUrl\(\)/, 'demo URL helper');
	assert.match(appJs, /demo@qase\.dev \/ demo1234/, 'demo credentials surfaced');
});

test('first-run journey stays concise while onboarding state is persisted', () => {
	assert.match(html, /<h2>Test a website<\/h2>/, 'concise empty-state heading');
	assert.doesNotMatch(html, /class="empty-note"/, 'technical credential copy is not permanent empty-state content');
	assert.doesNotMatch(appJs, /checklist\.append/, 'duplicate onboarding action card is not rendered');
	assert.match(appJs, /markOnboarded/, 'onboarding flag writer');
	assert.match(appJs, /onboardingComplete: true/, 'flag set to true on first run');
});

test('interrupted or errored runs expose a resume affordance', () => {
	assert.match(html, /id="resume-run"/, 'resume button in header');
	assert.match(appJs, /status === 'interrupted' \|\| status === 'error'/, 'shown for interrupted/error');
	assert.match(appJs, /text: 'continue'/, 'resume sends the continue message');
});

test('SQA report actions include fix-prompt export parity with QA', () => {
	assert.match(appJs, /qase-sqa-fix-prompts\.md/, 'SQA fix-prompt download filename');
	const sqaActions = appJs.slice(
		appJs.indexOf('function renderSqaReportActions'),
		appJs.indexOf('function renderSqaVerdict')
	);
	assert.match(sqaActions, /'Copy fix prompts'/, 'copy fix prompts button');
});

test('export failures map 409 pending-report errors to a friendly message', () => {
	assert.match(appJs, /function exportError/, 'exportError helper exists');
	assert.match(appJs, /still being finalized/, 'friendly pending-report copy');
});
