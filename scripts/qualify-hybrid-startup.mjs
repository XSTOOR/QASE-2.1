/** Check the real account's qualified startup path without running inference,
 * browsing a target, changing account settings or adding a saved user run. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureRuntime } from '../server/agent.js';
import { getConfig, withUserConfiguration, envKeyDestinationProblem } from '../server/config.js';
import { hybridEnabled, hybridProfile, loadQualification } from '../server/hybridConfig.js';

assert.equal(hybridEnabled(), true, 'Explicitly enable hybrid for this isolated startup check.');
const settings = getConfig();
const qualification = loadQualification(hybridProfile(settings));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-hybrid-startup-'));
const session = { id: randomUUID(), mode: 'qa', qaExecutionMode: 'hybrid', status: 'idle',
  targetUrl: 'https://fixture.invalid/', selectedTests: ['navigation'], messages: [], activities: [], findings: [], todos: [], secretNames: [] };
const live = {};
const store = {
  liveFor: () => live, listLive: () => [], publish() {},
  async commit(s) { fs.writeFileSync(path.join(root, 'checkpoint.json'), JSON.stringify(s), { mode: 0o600 }); },
  async addMessage(s, item) { s.messages.push(item); return item; },
  async addActivity(s, item) { s.activities.push(item); return item; },
  async updateActivity() {}, async setStatus(s, status) { s.status = status; }
};
let record;
try {
  await withUserConfiguration(settings, async () => { throw new Error('Startup verification must not change account settings.'); }, async () => {
    assert.equal(envKeyDestinationProblem(getConfig()), undefined);
    record = await ensureRuntime(session, store);
    assert.ok(record.runtime && record.hybrid && record.bridge);
    assert.equal(record.runtime.run, Object.getPrototypeOf(record.runtime).run);
    assert.ok(record.runtime.getAvailableToolCount() > 0);
    assert.equal(session.hybrid.reasoner.model, 'drytis/claude-opus-4.7');
    assert.equal(session.hybrid.classifier.model, 'jev-1.13');
    await record.hybrid.checkpoint();
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8'));
    assert.equal(saved.qaExecutionMode, 'hybrid');
    assert.ok(saved.hybrid.profileIdentity);
    console.log(JSON.stringify({ passed: true, credentialSourceProvider: settings.provider,
      sharedJevKeyInUse: Boolean(process.env.JEV_API_KEY && settings.apiKey === process.env.JEV_API_KEY),
      qualificationChecksPassed: Object.values(qualification.capabilities).filter(item => item.passed).length,
      runtimeConstructed: true, sdkLoopUnchanged: true, checkpointPersisted: true,
      inferenceInvoked: false, targetBrowsed: false, checkpoint: path.join(root, 'checkpoint.json') }, null, 2));
  });
} finally { if (record) { await record.bridge.service.dispose?.(); record.dispose(); } }
