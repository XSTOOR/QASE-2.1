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

test('launchers use platform models without customer provider setup prompts', () => {
	assert.doesNotMatch(html, /id="journey-(?:connection|configure|review-configure|setup)"/);
	const gate = appJs.slice(appJs.indexOf('function ensureModelConfigured('), appJs.indexOf('function fillSettings('));
	assert.match(gate, /Qase’s model service is unavailable/);
	assert.doesNotMatch(gate, /openSettings|Finish setup|API key/);
});

test('preferences do not ask for or submit customer gateway credentials', () => {
	assert.match(html, /id="cfg-managed-connection" hidden/);
	assert.doesNotMatch(html, /Connect your AI provider/);
	assert.match(html, /Models &amp; preferences/);
	const save = appJs.slice(appJs.indexOf('function readSettings()'), appJs.indexOf('cfg.provider.onchange'));
	assert.doesNotMatch(save, /apiKey|baseUrl|provider:/);
	assert.match(save, /model: selectedModelId/);
});

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
	assert.match(html, /<h2>Confidence before your next release\.<\/h2>/, 'concise empty-state heading');
	assert.match(html, /class="welcome-steps"/, 'first-run journey explains setup, execution, and results');
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
