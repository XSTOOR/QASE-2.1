#!/usr/bin/env node
/**
 * Live QA-engine qualification with the operator's real model keys.
 *
 *   npm run qualify:qa-live                      # QA Lab (seeded defects) only
 *   npm run qualify:qa-live -- https://staging.example.com   # also a real target
 *
 * Reads QASE_API_KEY / JEV_API_KEY (and optional QASE_REASONER_*) from the
 * environment or ./.env. Token use is capped (defaults below, override with
 * QASE_QA_REASONER_TOKENS / QASE_QA_JEV_CALLS). Writes a JSON scorecard and the
 * fix prompts to test-results/qa-live/<timestamp>/ and prints a summary:
 * seeded defects found, model calls/tokens, verdict and limitations.
 * Nothing is written to the run store; the target only receives read-only traffic.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { runQaEngine } from '../server/qa/engine.js';
import { startQaLab, SEEDED_DEFECTS } from '../server/qa/fixtureSite.js';
import { qaModelSettings } from '../server/qa/models.js';
import { buildAllFixPromptsMarkdown } from '../public/fixPromptBuilder.js';

const env = {
	...process.env,
	QASE_QA_REASONER_TOKENS: process.env.QASE_QA_REASONER_TOKENS ?? '250000',
	QASE_QA_REASONER_CALLS: process.env.QASE_QA_REASONER_CALLS ?? '40',
	QASE_QA_JEV_CALLS: process.env.QASE_QA_JEV_CALLS ?? '20',
	QASE_QA_MAX_MINUTES: process.env.QASE_QA_MAX_MINUTES ?? '15',
	QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: [process.env.QASE_BROWSER_ALLOWED_PRIVATE_HOSTS, '127.0.0.1'].filter(Boolean).join(',')
};
const settings = qaModelSettings(env, { apiKey: process.env.QASE_API_KEY || process.env.JEV_API_KEY });
if (!settings.reasoner.enabled && !settings.jev.enabled) {
	console.error('No model key found. Set QASE_API_KEY (or JEV_API_KEY) in the environment or .env.');
	process.exit(2);
}
const output = path.join('test-results', 'qa-live', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(output, { recursive: true });

function harness(targetUrl) {
	const session = { id: `qa-live-${Date.now()}`, mode: 'qa', targetUrl, engine: 'chromium', device: 'desktop', messages: [], activities: [], findings: [], todos: [] };
	const runStore = {
		async commit() {},
		async addMessage(s, message) { s.messages.push(message); if (message.role !== 'user') console.log(`  · ${String(message.text).split('\n')[0].slice(0, 160)}`); },
		async addActivity(s, activity) { s.activities.push(activity); return activity; },
		async updateActivity(s, id, patch) { const activity = s.activities.find(item => item.id === id); Object.assign(activity ?? {}, patch); if (activity && patch.status) console.log(`  ${patch.status === 'error' ? '✗' : '✓'} ${activity.label}: ${patch.summary ?? ''}`); },
		async setStatus(s, status) { s.status = status; },
		publish() {}
	};
	const artifacts = path.join(output, session.id);
	fs.mkdirSync(artifacts, { recursive: true });
	let count = 0;
	const artifactStore = { save: (_session, { bytes }) => { const artifactId = `ART-${++count}`; fs.writeFileSync(path.join(artifacts, `${artifactId}.jpg`), bytes); return { artifactId }; } };
	return { session, runStore, artifactStore };
}

async function run(label, targetUrl, envOverrides = {}) {
	console.log(`\n▶ ${label}: ${targetUrl}`);
	const { session, runStore, artifactStore } = harness(targetUrl);
	const started = Date.now();
	await runQaEngine({ session, runStore, record: {}, env: { ...env, ...envOverrides }, settings, artifactStore });
	const models = session.report?.qaEngine?.models ?? {};
	const result = {
		label, targetUrl, status: session.status, verdict: session.report?.verdict, seconds: Math.round((Date.now() - started) / 1000),
		findings: session.findings.map(({ title, severity, category, url, detector, source, score }) => ({ title, severity, category, url, detector, source, score })),
		limitations: session.report?.notCovered ?? [], models, coverage: session.report?.qaEngine?.coverage, summary: session.report?.summary
	};
	fs.writeFileSync(path.join(output, `${label}.json`), JSON.stringify(result, null, 2));
	fs.writeFileSync(path.join(output, `${label}-fix-prompts.md`), buildAllFixPromptsMarkdown(session) || '(no findings)');
	console.log(`  → ${result.status}, verdict ${result.verdict}, ${result.findings.length} findings in ${result.seconds}s`);
	console.log(`  → reasoner ${models.reasoner?.calls ?? 0} calls / ${models.reasoner?.tokens ?? 0} tokens${models.reasoner?.lastError ? ` (last error: ${models.reasoner.lastError})` : ''}; JEV ${models.jev?.calls ?? 0} calls${models.jev?.lastError ? ` (last error: ${models.jev.lastError})` : ''}`);
	for (const line of result.limitations) console.log(`  ! ${line}`);
	return { result, session };
}

const lab = await startQaLab();
let failed = false;
try {
	const { session } = await run('qa-lab', lab.url, { QASE_QA_MAX_PAGES: '6' });
	const found = new Set(session.findings.map(item => item.detector));
	const missed = SEEDED_DEFECTS.filter(defect => !found.has(defect.detector));
	console.log(`\n  Seeded defects found: ${SEEDED_DEFECTS.length - missed.length}/${SEEDED_DEFECTS.length}${missed.length ? ` (missed: ${missed.map(item => item.id).join(', ')})` : ''}`);
	const aiFindings = session.findings.filter(item => item.source !== 'detector').length;
	console.log(`  Findings from AI exploration / visual review: ${aiFindings}`);
	if (session.status !== 'done' || missed.length > 3) failed = true;
} finally {
	await lab.close();
}
for (const target of process.argv.slice(2)) {
	const { result } = await run(new URL(target).host.replace(/[^a-z0-9.-]/gi, '_'), target);
	if (result.status !== 'done') failed = true;
}
console.log(`\nResults written to ${output}`);
process.exit(failed ? 1 : 0);
