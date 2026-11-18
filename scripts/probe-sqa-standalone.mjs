// Isolated live capability probe. Its output is diagnostic, never an activation receipt.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CleanSlateNodeAgentRuntime, createNodeProviderConfiguration } from '@cleanslate/sdk';
import { chromium } from 'playwright';
import { getConfig } from '../server/config.js';
import { standaloneResearchProfile } from '../server/sqaStandaloneQualification.js';
import { createHybridUsageTransport } from '../server/hybridUsageTransport.js';
import { createSqaBrowserSmoke } from '../server/sqaBrowserSmoke.js';
import { createResearchTransport } from '../server/sqaResearchTransport.js';
import { SQA_STANDALONE_STRATEGY } from '../server/sqaStandaloneStrategy.js';

assert.equal(process.env.QASE_LIVE_SYSTEM_QUALIFICATION, 'true', 'Explicit live qualification opt-in required.');
assert.notEqual(process.env.NODE_ENV, 'production');
const profile = standaloneResearchProfile(getConfig());
const runId = randomUUID();
const report = { runId, strategy: SQA_STANDALONE_STRATEGY, sdk: profile.sdkVersion, model: profile.reasoner.model,
	search: 'unconfigured', modelRequests: 0, classifierAttempts: 0, browserChecks: 0, usage: [], qualified: false };
const started = Date.now();
const root = await mkdtemp(path.join(tmpdir(), 'sqa-standalone-probe-'));
const abort = AbortSignal.timeout(90000);
let browser, transport, runtime;
try {
	if (process.env.QASE_SQA_SEARCH_URL) {
		try {
			const url = new URL(process.env.QASE_SQA_SEARCH_URL);
			url.searchParams.set('q', 'W3C accessibility keyboard focus');
			url.searchParams.set('format', 'json');
			const response = await createResearchTransport()(url.href, {signal: abort, sameOrigin: true});
			assert.ok(Array.isArray(JSON.parse(response.content).results));
			report.search = { origin: url.origin, contentHash: response.contentHash, retrievedAt: response.retrievedAt };
		} catch (error) { report.search = { error: error.message }; }
	}
	assert.ok(profile.reasoner.apiKey, 'No configured reasoning credential.');
	browser = await chromium.launch({headless:true});
	const page = await browser.newPage();
	await page.setContent('<main><h1>Practice application</h1><label>Email <input></label><button>Preview</button></main>');
	const smoke = createSqaBrowserSmoke(page);
	const tool = {
		name:'inspect_fixture_keyboard', category:'sqa', description:'Inspect the actual forward and reverse keyboard focus sequence in the isolated practice form.',
		parametersSchema:{type:'object',properties:{},additionalProperties:false},
		async run() {
			assert.equal(report.browserChecks, 0, 'Repeated fixture check.');
			const result = await smoke.accessibility({steps: 2, reverse_steps: 1});
			report.browserChecks++;
			report.observation = result;
			return { success: true, observed: result, evidenceId: runId };
		}
	};
	transport = await createHybridUsageTransport(profile, {
		onUsage: value => report.usage.push({callId:value.callId, inputTokens:value.inputTokens, outputTokens:value.outputTokens, totalTokens:value.totalTokens}),
		async fetchImpl(url, options) {
			const body = JSON.parse(options.body);
			if (url !== profile.reasoner.endpoint || body.model !== profile.reasoner.model) {
				report.classifierAttempts++;
				throw new Error('Unexpected model dispatch.');
			}
			assert.ok(report.modelRequests < 3, 'Probe model call budget exhausted.');
			report.modelRequests++;
			return fetch(url, options);
		}
	});
	runtime = new CleanSlateNodeAgentRuntime({ rootPath: root,
		configuration:createNodeProviderConfiguration({provider:'custom',model:profile.reasoner.model,apiKey:transport.apiKey,baseUrl:transport.baseUrl,maxTurns:3}),
		approveTool:async ({toolName}) => toolName===tool.name, approveCommand:async()=>false,
		logger:{debug(){},info(){},warn(){},error(){}}
	});
	runtime.headlessRuntime.options.tools = [tool];
	runtime.headlessRuntime.toolsByName.clear();
	runtime.headlessRuntime.toolsByName.set(tool.name, tool);
	runtime.cleanSlateService.chat = transport.wrapChat(runtime.cleanSlateService.chat.bind(runtime.cleanSlateService));
	let answer = '';
	for await (const part of runtime.run('Use inspect_fixture_keyboard once to test actual focus movement, then summarize the observed keyboard behavior and include the returned evidenceId. Limit your conclusion to the tested form.', abort))
		if (part.type === 'chat_text') answer += part.content;
	abort.throwIfAborted();
	assert.equal(report.browserChecks, 1);
	assert.ok(answer.includes(runId), 'Final response did not cite the browser receipt.');
	assert.ok(report.modelRequests >= 2 && report.usage.length === report.modelRequests &&
		report.usage.every(row=>Number.isSafeInteger(row.totalTokens) && row.totalTokens>0), 'Missing exact usage for one or more requests.');
	report.samplePassed = true;
} catch (error) {
	report.error = String(error.message).slice(0, 500).replaceAll(profile.reasoner.apiKey || '__no_key__','[redacted]');
	process.exitCode = 1;
} finally {
	try { runtime?.dispose(); } finally {
		transport?.dispose(); await browser?.close(); await rm(root, {recursive:true,force:true});
	}
	report.elapsedMs = Date.now()-started;
	console.log(JSON.stringify(report, null, 2));
}
