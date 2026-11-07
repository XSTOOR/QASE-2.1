import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { createRuntimeApplicationServices } from './localServices.js';
import { hybridQualificationService } from './hybridQualificationService.js';
import { runWithRequestActor } from './requestActor.js';

const RUN_ID = '6bf078e0-20df-48c3-a6f8-eb74ca14b9e1';

test('acknowledged Founder checkpoints and usage survive immediate process exit', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qase-founder-crash-'));
	const moduleUrl = new URL('./localServices.js', import.meta.url).href;
	try {
		const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
			import { createLocalApplicationServices } from ${JSON.stringify(moduleUrl)};
			const services = createLocalApplicationServices({});
			await services.runs.load();
			const session = await services.runs.create('Founder crash boundary');
			session.mode = 'founder';
			session.founder = { scope: {}, observations: [], reportDraft: { revision: 'saved', input: { executive_summary: 'Persisted before acknowledgement.' } } };
			session.tokenUsage = { inputTokens: 521118, outputTokens: 42600, totalTokens: 563718 };
			await services.runs.setStatus(session, 'running');
			await services.runs.commit(session, 'founder.report_draft');
			session.tokenUsage.inputTokens += 100;
			session.tokenUsage.totalTokens += 100;
			await services.runs.commit(session, 'usage');
			await services.runs.setStatus(session, 'interrupted', 'Stopped by user.');
			process.stdout.write(session.id);
			process.exit(0); // No debounce delay, lifecycle close or exit flush.
		`], { cwd: directory, encoding: 'utf8', timeout: 30_000, windowsHide: true });
		assert.equal(child.status, 0, child.stderr || child.error?.message);
		const saved = JSON.parse(await fs.readFile(path.join(directory, '.qase', 'sessions.json'), 'utf8')).find(s => s.id === child.stdout);
		assert.equal(saved.founder.reportDraft.input.executive_summary, 'Persisted before acknowledgement.');
		assert.deepEqual(saved.tokenUsage, { inputTokens: 521218, outputTokens: 42600, totalTokens: 563818 });
		assert.equal(saved.status, 'interrupted');assert.equal(saved.statusDetail, 'Stopped by user.');
		const restored = spawnSync(process.execPath, ['--input-type=module', '-e', `
			import { createLocalApplicationServices } from ${JSON.stringify(moduleUrl)};
			const services = createLocalApplicationServices({}); await services.runs.load();
			const session = await services.runs.getAny(${JSON.stringify(child.stdout)});
			process.stdout.write(JSON.stringify({ draft: session.founder.reportDraft, usage: session.tokenUsage, status: session.status, detail: session.statusDetail, interruptedFromRun: session.interruptedFromRun === true }));
			process.exit(0);
		`], { cwd: directory, encoding: 'utf8', timeout: 30_000, windowsHide: true });
		assert.equal(restored.status, 0, restored.stderr || restored.error?.message);
		assert.deepEqual(JSON.parse(restored.stdout), { draft: saved.founder.reportDraft, usage: saved.tokenUsage, status: 'interrupted', detail: 'Stopped by user.', interruptedFromRun: false });
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Founder commits refuse acknowledgement when the local checkpoint cannot be written', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qase-founder-write-failure-'));
	const moduleUrl = new URL('./localServices.js', import.meta.url).href;
	try {
		const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
			import assert from 'node:assert/strict';
			import fs from 'node:fs';
			import { createLocalApplicationServices } from ${JSON.stringify(moduleUrl)};
			const services = createLocalApplicationServices({}); await services.runs.load();
			const session = await services.runs.create('Founder unwritable checkpoint');
			session.mode = 'founder';
			fs.mkdirSync('.qase/sessions.json', { recursive: true });
			let published = false;
			services.runs.subscribe(session.id, () => { published = true; });
			await assert.rejects(services.runs.commit(session, 'founder.report_draft'));
			assert.equal(published, false);
			process.exit(0);
		`], { cwd: directory, encoding: 'utf8', timeout: 30_000, windowsHide: true });
		assert.equal(child.status, 0, child.stderr || child.error?.message);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('qualification renewal binds concurrent accounts to their own effective credentials',async()=>{
 const start=hybridQualificationService.start,lock=process.env.QASE_LOCK_MODEL,seen=[];
 hybridQualificationService.start=profile=>{seen.push(profile.reasoner.apiKey);};process.env.QASE_LOCK_MODEL='false';
 try{
  const services=createRuntimeApplicationServices({}, {auth:{async getSettings(id){await new Promise(resolve=>setImmediate(resolve));return{provider:'jev',model:'jev-1.13',baseUrl:'https://llm.drytis.ai/typesafe/api/alpha/decisions',apiKey:`fixture-key-${id}`};}}});
  const configs=await Promise.all(['account-a','account-b'].map(actorUserId=>runWithRequestActor({actorUserId},()=>services.configuration.qualifyHybrid())));
  assert.deepEqual(seen.sort(),['fixture-key-account-a','fixture-key-account-b']);
  assert.ok(configs.every(config=>!Object.hasOwn(config,'apiKey')));
 }finally{hybridQualificationService.start=start;if(lock===undefined)delete process.env.QASE_LOCK_MODEL;else process.env.QASE_LOCK_MODEL=lock;}
});

test('stop aborts a running turn but leaves the runtime for the loop to finalize', () => {
	const calls = [];
	const record = {
		running: true,
		controller: { abort: () => calls.push('abort') },
		dispose: () => calls.push('dispose')
	};
	const services = createRuntimeApplicationServices({ peekLive: () => record });
	services.agent.stop(RUN_ID);
	assert.deepEqual(calls, ['abort']);
});

test('stop on a non-running session disposes the stray runtime and stops frame streaming', () => {
	// The production gap: after a crash/recovery or an idle keep-open, the
	// run is not live but its browser runtime still holds Chromium. stop()
	// used to be a silent no-op, leaving the browser resident indefinitely.
	const calls = [];
	const record = {
		running: false,
		bridge: { stopFrames: () => calls.push('stopFrames') },
		dispose: () => calls.push('dispose'),
		runtime: {}
	};
	const services = createRuntimeApplicationServices({ peekLive: () => record });
	services.agent.stop(RUN_ID);
	assert.deepEqual(calls, ['stopFrames', 'dispose']);
	assert.equal(record.runtime, undefined, 'runtime reference dropped');
	assert.equal(record.bridge, undefined, 'bridge reference dropped');
});

test('stop is a safe no-op when no live record exists', () => {
	const services = createRuntimeApplicationServices({ peekLive: () => undefined });
	assert.doesNotThrow(() => services.agent.stop(RUN_ID));
});

test('stop on a non-running session is idempotent', () => {
	const calls = [];
	let record = {
		running: false,
		bridge: { stopFrames: () => calls.push('stopFrames') },
		dispose: () => calls.push('dispose'),
		runtime: {}
	};
	const services = createRuntimeApplicationServices({ peekLive: () => record });
	services.agent.stop(RUN_ID);
	services.agent.stop(RUN_ID);
	assert.deepEqual(calls, ['stopFrames', 'dispose'], 'second stop finds no bridge/dispose and does nothing');
});

test('events surface the run store\'s global subscription when available', async () => {
	const seen = [];
	const runStore = {
		publish() {},
		subscribe() {},
		subscribeGlobal(listener) {
			seen.push('registered');
			listener('session-a', { type: 'usage', usage: { totalTokens: 10 } });
			return () => seen.push('unsubscribed');
		}
	};
	const services = createRuntimeApplicationServices(runStore, {});
	assert.equal(typeof services.events.subscribeGlobal, 'function');
	const unsubscribe = services.events.subscribeGlobal((sessionId, event) => seen.push([sessionId, event.type]));
	assert.deepEqual(seen, ['registered', ['session-a', 'usage']]);
	unsubscribe();
	assert.equal(seen.at(-1), 'unsubscribed');
});

test('events omit subscribeGlobal when the store has none', () => {
	const services = createRuntimeApplicationServices({ publish() {}, subscribe() {} }, {});
	assert.equal(services.events.subscribeGlobal, undefined);
});

test('artifact purge uses only non-creating live lookup and always drops the record', async () => {
	const calls = [];
	let record = {
		controller: { abort: () => calls.push('abort') },
		dispose: () => calls.push('dispose')
	};
	const runStore = {
		peekLive: () => record,
		dropLive: () => {
			calls.push('drop');
			record = undefined;
		},
		liveFor: () => {
			throw new Error('purge must not create a live record');
		}
	};
	const services = createRuntimeApplicationServices(runStore, {
		purgeRunWorkspace: async runId => calls.push(`workspace:${runId}`)
	});

	await services.agent.purgeArtifacts(RUN_ID);
	await services.agent.purgeArtifacts(RUN_ID);
	assert.deepEqual(calls, [
		'abort', 'dispose', 'drop', `workspace:${RUN_ID}`,
		'drop', `workspace:${RUN_ID}`
	]);
});

test('artifact purge still removes workspace and live entry when runtime disposal fails', async () => {
	const calls = [];
	const failure = new Error('runtime dispose failed');
	const runStore = {
		peekLive: () => ({ dispose: () => { throw failure; } }),
		dropLive: () => calls.push('drop'),
		liveFor: () => { throw new Error('must not be called'); }
	};
	const services = createRuntimeApplicationServices(runStore, {
		purgeRunWorkspace: async () => calls.push('workspace')
	});

	await assert.rejects(services.agent.purgeArtifacts(RUN_ID), failure);
	assert.deepEqual(calls, ['drop', 'workspace']);
});

test('setFindingStatus mutates, persists, and broadcasts the finding_status event', async () => {
	const originalDirectory = process.cwd();
	const isolatedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'qase-local-finding-status-'));
	try {
		process.chdir(isolatedDirectory);
		const { createLocalApplicationServices } = await import(`./localServices.js?status=${Date.now()}`);
		const services = createLocalApplicationServices({});
		await services.runs.load();
		const session = await services.runs.create('Bug tracking run', {});
		const finding = {
			id: randomUUID(), ts: 500, severity: 'high', title: 'Broken filter',
			category: 'search', url: 'https://example.test/search', expected: 'filters', actual: 'ignores input'
		};
		session.findings = [finding];

		const events = [];
		const unsubscribe = services.runs.subscribe(session.id, event => events.push(event));

		const updated = await services.runs.setFindingStatus(session, finding.id, { status: 'in_progress', note: 'assigned' });
		assert.equal(updated.status, 'in_progress');
		assert.equal(updated.statusNote, 'assigned');

		const broadcast = events.filter(event => event.type === 'finding_status');
		assert.equal(broadcast.length, 1);
		assert.equal(broadcast[0].finding.id, finding.id);
		assert.equal(broadcast[0].finding.status, 'in_progress');

		const rows = await services.runs.aggregateFindings({ ownerUserId: session.ownerUserId });
		assert.equal(rows.length, 1);
		assert.equal(rows[0].status, 'in_progress');
		assert.equal(rows[0].runTitle, 'Bug tracking run');

		await assert.rejects(
			() => services.runs.setFindingStatus(session, randomUUID(), { status: 'fixed' }),
			error => error.code === 'QASE_FINDING_NOT_FOUND'
		);
		unsubscribe();
	} finally {
		process.chdir(originalDirectory);
		await fs.rm(isolatedDirectory, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// R4 #14493 · Evidence bundle persistence
// ---------------------------------------------------------------------------

test('R4: saveEvidenceBundle persists a runtime-sourced JSON artifact with honest metadata', async t => {
	// collectEvidenceBundle unit coverage lives in evidenceBundle.test.js;
	// here we assert the honest-absent contract through the composed path.
	const { collectEvidenceBundle } = await import('./evidenceBundle.js');
	const bundle = collectEvidenceBundle({
		session: { id: '00000000-0000-4000-8000-000000000000', runtimeFacts: null },
		bridge: {},
		diagnostics: null
	}).bundle;
	assert.equal(bundle.type, 'evidence-bundle');
	assert.equal(bundle.console, null, 'unobservable console is recorded absent, never fabricated');
});
