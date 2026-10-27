import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CleanSlateNodeAgentRuntime, createNodeProviderConfiguration } from '@cleanslate/sdk';
import { chromium } from 'playwright';
import { getConfig } from '../server/config.js';
import { hybridProfile, qualificationPath } from '../server/hybridConfig.js';
import { qualifyHybridGateway } from '../server/hybridGatewayQualification.js';
import { attachUsageCapture } from '../server/usageCapture.js';
import { createHybridUsageTransport } from '../server/hybridUsageTransport.js';

const profile = hybridProfile(getConfig());
if (!profile.reasoner.apiKey) throw new Error('A configured server API key is required.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-hybrid-gateway-'));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
  await page.setContent('<html style="background:rgb(255,0,0)"><body></body></html>');
  const imageUrl = `data:image/png;base64,${(await page.screenshot()).toString('base64')}`;
  const report = await qualifyHybridGateway(profile, { imageUrl, sdkProbe: async () => {
    const exactUsage = [];
    const transport = await createHybridUsageTransport(profile, { onUsage: item => exactUsage.push(item) });
    const runtime = new CleanSlateNodeAgentRuntime({ rootPath: root, configuration: createNodeProviderConfiguration({ provider: 'custom', model: profile.reasoner.model, apiKey: transport.apiKey, baseUrl: transport.baseUrl, maxTurns: 5 }),
      approveCommand: async () => false, approveTool: async ({ toolName }) => toolName === 'qa_echo', logger: { debug() {}, info() {}, warn() {}, error() {} },
      resolveAttachments: () => [{ type: 'image_url', image_url: { url: imageUrl } }],
      additionalContext: 'This is an isolated protocol qualification. Use only qa_echo. Do not access browsers, files, commands, or external data.' });
    const calls = [], usage = [];
    // Use the same registry integration seam QASE already uses in agent.js.
    const probe = { name: 'qa_echo', description: 'Harmless fixture: returns a fixed observation.', category: 'qa', parametersSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      async run(input) { calls.push(input.value); return { success: true, value: input.value, observation: 'fixture-received' }; } };
    runtime.headlessRuntime.options.tools = [probe]; runtime.headlessRuntime.toolsByName.clear(); runtime.headlessRuntime.toolsByName.set(probe.name, probe);
    const release = attachUsageCapture(runtime.cleanSlateService, { onUsage: item => usage.push(item) });
    runtime.cleanSlateService.chat = transport.wrapChat(runtime.cleanSlateService.chat.bind(runtime.cleanSlateService));
    let finalText = '';
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 90000);
    try {
      for await (const part of runtime.run('Call qa_echo once with value alpha, read its result, then reply fixture-received and the color filling the attached image, and finish.', controller.signal)) {
        if (part.type === 'chat_text') finalText += part.content || '';
      }
      assert.deepEqual(calls, ['alpha']); assert.match(finalText, /fixture-received/);
      assert.match(finalText, /red/i, 'SDK image attachment was not recognized');
      const cancel = new AbortController(); const cancelTimer = setTimeout(() => cancel.abort(), 100); const began = Date.now();
      try { for await (const _part of runtime.run('Do not use tools. Count slowly from one to one thousand.', cancel.signal)) { /* private stream is not logged */ } } catch { /* SDK can terminate by throwing or ending the iterable. */ }
      finally { clearTimeout(cancelTimer); }
      assert.ok(cancel.signal.aborted && Date.now() - began < 5000, 'SDK cancellation was not bounded');
      assert.equal(calls.length, 1, 'Cancellation must not execute another tool');
      const totals = items => items.reduce((sum, item) => sum + item.totalTokens, 0);
      assert.ok(exactUsage.length >= 2, 'Tool call and continuation both need exact usage');
      assert.equal(usage.length, exactUsage.length, 'SDK usage must match completed transport calls exactly once');
      assert.equal(totals(usage), totals(exactUsage), 'SDK and transport usage totals differ');
      assert.equal(new Set(exactUsage.map(item => item.callId)).size, exactUsage.length);
      return { toolExecutions: calls.length, continuationVerified: true, imageVerified: true, cancellationVerified: true,
        usageReported: usage.every(item => Number.isSafeInteger(item.totalTokens) && item.totalTokens > 0),
        usageTransport: transport.version, completedUsageCalls: exactUsage.length, reportedTotalTokens: totals(exactUsage), accountingMatched: true };
    } finally { clearTimeout(timer); release(); runtime.dispose(); transport.dispose(); }
  } });
  const target = qualificationPath(profile);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ path: target, ...report }, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally { await browser?.close(); /* retain the isolated SDK fixture directory for inspection */ }
