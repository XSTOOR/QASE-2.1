import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig, withUserConfiguration } from '../server/config.js';
import { hybridProfile, loadQualification } from '../server/hybridConfig.js';
import { runTurn } from '../server/agent.js';
import { startHybridBenchmarkFixture } from '../server/hybridBenchmarkFixture.js';
import { HYBRID_BENCHMARK_MANIFEST, benchmarkMetrics } from '../server/hybridBenchmark.js';

const output = path.resolve('test-results', `hybrid-benchmark-${Date.now()}`);
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const profile = hybridProfile(getConfig());
const result = { version: 1, manifest: HYBRID_BENCHMARK_MANIFEST, status: 'not_run',
  comparableBudgets: { durationMs: 300000, approvedBrowserToolCalls: 180, fixtureRoutes: 2 }, runs: [] };
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
if (!process.argv.includes('--live')) {
  result.reason = 'Live inference requires --live and a successful current gateway/SDK qualification. No measurements have been generated.';
  save(); console.log(JSON.stringify({ output, ...result }, null, 2));
} else {
  let qualified = false;
  try { loadQualification(profile); qualified = true; }
  catch (error) { result.status = 'blocked'; result.reason = error.message; save(); console.log(JSON.stringify({ output, ...result }, null, 2)); process.exitCode = 2; }
  if (qualified) {
    const fixture = await startHybridBenchmarkFixture();
    const savedEnv = Object.fromEntries(['NODE_ENV', 'QASE_ALLOW_PRIVATE_NETWORK', 'QASE_HYBRID_QA_ENABLED', 'QASE_HYBRID_DURATION_MS', 'QASE_JEV_MAX_SECONDS', 'QASE_JEV_MAX_PAGES'].map(key => [key, process.env[key]]));
    // These flags affect only this explicit isolated-fixture subprocess.
    process.env.NODE_ENV = 'development'; process.env.QASE_ALLOW_PRIVATE_NETWORK = 'true'; process.env.QASE_HYBRID_QA_ENABLED = 'true';
    process.env.QASE_HYBRID_DURATION_MS = '300000'; process.env.QASE_JEV_MAX_SECONDS = '300'; process.env.QASE_JEV_MAX_PAGES = '2';
    try {
      await withUserConfiguration({ provider: 'jev', model: profile.classifier.model, baseUrl: profile.classifier.endpoint, apiKey: profile.classifier.apiKey }, async () => {}, async () => {
        for (const strategy of ['legacy', 'hybrid']) {
          const session = { id: randomUUID(), mode: 'qa', qaExecutionMode: strategy, status: 'idle', targetUrl: fixture.url, selectedTests: [...HYBRID_BENCHMARK_MANIFEST.checks], messages: [], activities: [], findings: [], todos: [], secretNames: [] };
          const live = {}; const started = Date.now();
          const store = {
            liveFor: () => live, listLive: () => [], publish() {}, async commit() {},
            async setStatus(s, status, detail) { s.status = status; s.statusDetail = detail; },
            async addActivity(s, item) {
              if (String(item.toolName).startsWith('browser_') && s.activities.filter(activity => String(activity.toolName).startsWith('browser_')).length >= result.comparableBudgets.approvedBrowserToolCalls) { live.controller?.abort(); throw new Error('Benchmark approved browser-tool budget exhausted.'); }
              const next = { id: randomUUID(), ts: Date.now(), ...item }; s.activities.push(next); return next;
            },
            async updateActivity(s, id, patch) { Object.assign(s.activities.find(item => item.id === id), patch); },
            async addMessage(s, item) { const next = { id: randomUUID(), ts: Date.now(), ...item }; s.messages.push(next); return next; }
          };
          const deadline = setTimeout(() => live.controller?.abort(), result.comparableBudgets.durationMs);
          try { await runTurn(session, { task: `Test ${fixture.url}, an authorized loopback fixture. Scope navigation, responsive geometry, images and local search only. Execute host checks, safely reproduce defects, and publish evidence-linked results. Do not submit or create anything.` }, store); }
          finally { clearTimeout(deadline); await live.bridge?.service.dispose?.(); live.dispose?.(); }
          result.runs.push({ strategy: strategy === 'legacy' ? 'JEV-only' : 'Opus+JEV+CleanSlate', latencyMs: Date.now() - started, ...benchmarkMetrics(session) }); save();
        }
      });
      result.status = 'measured'; result.targetWrites = fixture.writes();
    } finally { await fixture.close(); for (const [key, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value; save(); }
    console.log(JSON.stringify({ output, ...result }, null, 2));
  }
}
