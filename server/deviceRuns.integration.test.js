/**
 * QA, SQA and Founder runs on selected devices and browsers, end to end in a
 * real browser against the QA Lab: each run must launch the engine its
 * browser belongs to, present the device's user agent, viewport and touch
 * screen, name the selected browser in the conversation, record matching
 * runtime facts, and finish. Engines not installed here are skipped with a
 * reason (CI installs Chromium, Firefox and WebKit).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateEnvironments } from './environmentCatalog.js';
import { environmentEmulationOptions } from './browserstackProvider.js';
import { resolveEngine } from './browserEngines.js';
import { engineForEnvironment } from './runRuntime.js';
import { startQaLab } from './qa/fixtureSite.js';
import { runQaEngine } from './qa/engine.js';
import { qaModelSettings } from './qa/models.js';
import { runSqaEngine, createSqaRunState } from './sqa/engine.js';
import { runFounderEngine, createFounderRunState } from './founder/engine.js';

const ENV = {
	...process.env, NODE_ENV: 'test', QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1', QASE_QA_ASK_CREDENTIALS: 'false', QASE_AGENT_CURSOR: 'false',
	QASE_QA_MAX_MINUTES: '3', QASE_QA_MAX_PAGES: '4', QASE_QA_VIEWPORT_PAGES: '1', QASE_QA_INTERACTION_PAGES: '1',
	QASE_SQA_MAX_MINUTES: '6', QASE_SQA_KEY_PAGES: '3', QASE_FOUNDER_MAX_MINUTES: '6', QASE_FOUNDER_KEY_PAGES: '3'
};
const UA_PLATFORM = { ios: /iPhone/, ipados: /iPad/, android: /Android/, windows: /Windows NT/, macos: /Macintosh/ };

function newest(platform, browserCode, deviceType) {
	return generateEnvironments().filter(env => env.active && env.platform === platform && env.browserCode === browserCode && env.deviceType === deviceType)
		.sort((a, b) => Number.parseFloat(b.osVersion) - Number.parseFloat(a.osVersion))[0];
}

const DEVICES = [
	newest('android', 'chrome', 'mobile'),
	newest('windows', 'edge', 'desktop'),
	newest('ios', 'safari', 'mobile'),
	newest('macos', 'firefox', 'desktop')
];

function harness(mode, targetUrl, environment) {
	const session = {
		id: `${mode}-${Math.random().toString(16).slice(2)}`, mode, targetUrl, engine: engineForEnvironment(environment), device: 'desktop',
		environmentId: environment.envId, environmentSnapshot: environment, messages: [], activities: [], findings: [], todos: []
	};
	if (mode === 'sqa') session.sqa = createSqaRunState({});
	if (mode === 'founder') session.founder = createFounderRunState({ targetUrl, brief: { goals: 'Get sign-ups', customers: 'Small agencies' } });
	const runStore = {
		async commit() {}, publish() {},
		async addMessage(s, message) { s.messages.push(message); },
		async addActivity(s, activity) { const entry = { id: activity.id ?? Math.random().toString(16).slice(2), ...activity }; s.activities.push(entry); return entry; },
		async updateActivity(s, id, patch) { Object.assign(s.activities.find(item => item.id === id) ?? {}, patch); },
		async setStatus(s, status) { s.status = status; }
	};
	return { session, runStore, artifactStore: { save: () => ({ artifactId: `ART-${Math.random().toString(16).slice(2, 8)}` }) } };
}

function assertDeviceRun(session, environment) {
	const facts = session.runtimeFacts ?? {};
	const emulation = environmentEmulationOptions(environment);
	assert.equal(session.status, 'done', `${session.mode} on ${environment.envId} finished (${session.statusDetail ?? ''})`);
	assert.equal(facts.launchedEngineId, engineForEnvironment(environment), 'the engine of the selected browser ran');
	assert.match(facts.userAgent ?? '', UA_PLATFORM[environment.platform], 'the site saw the device\'s own user agent');
	assert.equal(facts.viewport?.width, emulation.viewport.width, 'the device viewport was applied');
	assert.equal(facts.maxTouchPoints > 0, Boolean(emulation.hasTouch), 'touch matches the device');
	const limitations = JSON.stringify(session.hybrid?.limitations ?? session.sqa?.limitations ?? session.founder?.limitations ?? []);
	assert.doesNotMatch(limitations, /does not fully match/, 'the browser that ran matches the selection');
	assert.ok(session.messages.some(message => String(message.text ?? '').includes(environment.browser)), 'the conversation names the selected browser');
}

for (const environment of DEVICES) {
	const engine = engineForEnvironment(environment);
	const label = `${environment.device} · ${environment.browser} (${engine})`;
	const available = (await resolveEngine(engine)).available;
	const skip = available ? false : `${engine} is not installed here (npm run install-browser)`;

	test(`QA runs on ${label}`, { timeout: 300_000, skip }, async () => {
		const lab = await startQaLab();
		try {
			const { session, runStore, artifactStore } = harness('qa', `${lab.url}edu/`, environment);
			await runQaEngine({ session, runStore, record: {}, env: ENV, settings: qaModelSettings({}, {}), artifactStore });
			assertDeviceRun(session, environment);
			assert.ok(session.hybrid.coverage.viewports.some(item => item.startsWith(environment.device)), 'the device is the primary viewport');
		} finally { await lab.close(); }
	});

	test(`SQA runs on ${label}`, { timeout: 300_000, skip }, async () => {
		const lab = await startQaLab();
		try {
			const { session, runStore, artifactStore } = harness('sqa', `${lab.url}edu/`, environment);
			await runSqaEngine({ session, runStore, record: {}, env: ENV, settings: { reasoner: { enabled: false } }, artifactStore });
			assertDeviceRun(session, environment);
		} finally { await lab.close(); }
	});

	test(`Founder runs on ${label}`, { timeout: 300_000, skip }, async () => {
		const lab = await startQaLab();
		try {
			const { session, runStore, artifactStore } = harness('founder', `${lab.url}saas/`, environment);
			await runFounderEngine({ session, runStore, record: {}, env: ENV, settings: { reasoner: { enabled: false } }, artifactStore });
			assertDeviceRun(session, environment);
		} finally { await lab.close(); }
	});
}
