// #17997 E2E driver v2: answers BOTH budget AND coverage questions to drive a
// hybrid QA run to an honest terminal outcome.
import 'dotenv/config';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runTurn, deleteRunSnapshot } from '../server/agent.js';
import { applyHostDecision } from '../server/hybridContinuation.js';

if (!process.env.QASE_LIVE_HYBRID_EXECUTION) process.env.QASE_LIVE_HYBRID_EXECUTION = 'true';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-e2e-hybrid-v2-'));
const server = http.createServer((request, response) => {
	if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
	response.setHeader('Content-Type', 'text/html');
	const docs = request.url === '/docs';
	response.end(`<!doctype html><html lang="en"><head><title>${docs ? 'Documentation' : 'QA fixture'}</title></head><body><header><a href="/">Home</a> <a id="docs" href="/docs">Documentation</a></header><main><h1>${docs ? 'Documentation' : 'Disposable QA fixture'}</h1><p>All pages are local read-only fixtures.</p><div style="width:1800px;height:40px">Intentional horizontal overflow fixture</div><img src="/pixel.svg" alt="Decorative fixture" width="10" height="10"></main></body></html>`);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const targetUrl = `http://127.0.0.1:${server.address().port}/`;
const session = {
	id: randomUUID(), mode: 'qa', qaExecutionMode: 'hybrid', status: 'idle',
	targetUrl, selectedTests: ['navigation', 'responsive', 'accessibility'],
	messages: [], activities: [], findings: [], todos: [], secretNames: [], ownerUserId: 'isolated-e2e-v2'
};
const live = {};
const store = {
	liveFor: () => live, listLive: () => [], publish() {},
	async commit(s) { fs.writeFileSync(path.join(root, 'checkpoint.json'), JSON.stringify(s), { mode: 0o600 }); },
	async setStatus(s, status, detail) { s.status = status; s.statusDetail = detail; console.log('[status]', status, detail ?? ''); },
	async addActivity(s, item) { const value = { id: randomUUID(), ts: Date.now(), ...item }; s.activities.push(value); console.log('[tool]', value.toolName); return value; },
	async updateActivity(s, id, patch) { Object.assign(s.activities.find(item => item.id === id) ?? {}, patch); if (patch.error) console.log('[tool error]', patch.error); },
	async addMessage(s, item) { const value = { id: randomUUID(), ts: Date.now(), ...item }; s.messages.push(value); return value; }
};
const task = `Test ONLY ${targetUrl} with the selected navigation, responsive and accessibility scenarios. It is an authorized disposable read-only fixture with an entry page linking to /docs. Exercise the Documentation anchor with its exact href, fixed responsive checks, and fixed accessibility checks. File only reproduced host-verified defects. Work each existing scenario to an honest disposition, finish all todos, then publish the evidence-based report. Do not expand scope or submit anything. Prefer bounded host checks over redundant screenshots or repeated planning.`;
session.messages.push({ id: randomUUID(), role: 'user', text: task, ts: Date.now() });
const began = Date.now();
try {
	await runTurn(session, { task }, store);
	let round = 0;
	while (session.status === 'awaiting_input' && session.pendingQuestion && round < 6) {
		const decision = session.pendingQuestion.hybridDecision;
		console.log('[question]', decision, '—', String(session.pendingQuestion.question).slice(0, 100));
		const answer = decision === 'budget'
			? 'Continue testing: approve +300,000 Opus tokens, +50,000 JEV tokens, +15 min, +180 browser actions and up to 8 page attempts'
			: 'Publish the report with explicit coverage gaps';
		round += 1;
		// Mirror the real /api/sessions/:id/answer route: applyHostDecision
		// first (it approves budgets / marks partial-report), THEN resume.
		const applied = applyHostDecision(session, answer);
		if (!applied) throw new Error('host decision could not be applied: ' + answer);
		await store.addMessage(session, { role: 'user', text: answer, kind: 'answer' });
		await runTurn(session, { resumeAnswer: answer }, store);
	}
	const metric = session.hybrid.telemetry;
	const result = {
		status: session.status, detail: session.statusDetail, rounds: round, elapsedMs: Date.now() - began,
		reasoner: metric.reasoner, classifier: metric.classifier, browserActions: metric.browserActions,
		tokenUsage: session.tokenUsage,
		scenarios: session.hybrid.scenarios.map(({ category, status }) => ({ category, status })),
		confirmedFindings: session.findings.filter(item => item.hybridEvidence).length,
		reportVerdict: session.report?.verdict, reportTs: session.report?.ts,
		notCovered: session.report?.notCovered?.length ?? 0, root
	};
	fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
	console.log(JSON.stringify(result, null, 2));
} finally {
	await live.bridge?.service?.dispose();
	live.dispose?.();
	deleteRunSnapshot(session.id);
	server.closeAllConnections(); server.close();
}
