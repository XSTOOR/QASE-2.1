/** Automatic Hybrid QA qualification keeper (#17924).
 *
 * Gateway qualification receipts expire after 24h (hybridConfig
 * validateQualification). Before this keeper, receipts were produced only by the
 * manual deploy-time script scripts/qualify-hybrid-gateway.mjs, so every
 * deployment dead-ended the hybrid launcher ("Review test run" blocked with
 * "compatibility check expired") about a day later. This module re-runs the
 * SAME full gateway qualification in-process, on boot and on a recurring
 * timer, whenever the receipt is missing, expired, or close to expiry.
 *
 * Contract:
 * - Fail-closed: a failed requalification never fabricates availability. It
 *   leaves the previous receipt untouched (loadQualification stays the single
 *   source of truth) and retries on the next tick.
 * - Non-fatal: any error is logged, never thrown; the server keeps serving.
 * - The receipt is written exactly like the script: qualificationPath(profile),
 *   mode 0o600, directory 0o700.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { CleanSlateNodeAgentRuntime, createNodeProviderConfiguration } from '@cleanslate/sdk';
import assert from 'node:assert/strict';
import { hybridProfile, qualificationPath, loadQualification, hybridEnabled } from './hybridConfig.js';
import { qualifyHybridGateway } from './hybridGatewayQualification.js';
import { attachUsageCapture } from './usageCapture.js';
import { createHybridUsageTransport } from './hybridUsageTransport.js';
import { getConfig } from './config.js';

export const RECEIPT_TTL_MS = 86_400_000;
export const DEFAULT_TICK_MS = 15 * 60 * 1000;

/** How long before expiry a still-valid receipt should be refreshed early. */
export const requalifyAheadMs = () => {
  const raw = Number(process.env.QASE_HYBRID_REQUALIFY_AHEAD_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2 * 60 * 60 * 1000;
};

/** Milliseconds until the receipt at `path` should be re-run. Negative/0 =
 *  run now. Missing receipt → run now. Unreadable/malformed → run now (the
 *  run itself is what restores a valid receipt or reports honestly). */
export async function timeUntilRequalification(profile, { readFile = fs.promises.readFile } = {}) {
  try {
    const raw = await readFile(qualificationPath(profile), 'utf8');
    const report = JSON.parse(raw);
    if (!Number.isFinite(report.checkedAt)) return 0;
    const expiresIn = report.checkedAt + RECEIPT_TTL_MS - Date.now();
    return Math.max(0, expiresIn - requalifyAheadMs());
  } catch {
    return 0;
  }
}

/** Full in-process gateway qualification, mirroring
 *  scripts/qualify-hybrid-gateway.mjs (same 13 capability checks, same SDK
 *  probe loop, same image fixture). Returns the report; throws on hard
 *  infrastructure failure. A report with passed=false is still returned. */
export async function runFullQualification(profile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-hybrid-keeper-'));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
    await page.setContent('<html style="background:rgb(255,0,0)"><body></body></html>');
    const imageUrl = `data:image/png;base64,${(await page.screenshot()).toString('base64')}`;
    const report = await qualifyHybridGateway(profile, {
      imageUrl,
      sdkProbe: async () => {
        const exactUsage = [];
        const transport = await createHybridUsageTransport(profile, { onUsage: item => exactUsage.push(item) });
        const runtime = new CleanSlateNodeAgentRuntime({
          rootPath: root,
          configuration: createNodeProviderConfiguration({ provider: 'custom', model: profile.reasoner.model, apiKey: transport.apiKey, baseUrl: transport.baseUrl, maxTurns: 5 }),
          approveCommand: async () => false,
          approveTool: async ({ toolName }) => toolName === 'qa_echo',
          logger: { debug() {}, info() {}, warn() {}, error() {} },
          resolveAttachments: () => [{ type: 'image_url', image_url: { url: imageUrl } }],
          additionalContext: 'This is an isolated protocol qualification. Use only qa_echo. Do not access browsers, files, commands, or external data.'
        });
        const calls = [], usage = [];
        const probe = {
          name: 'qa_echo', description: 'Harmless fixture: returns a fixed observation.', category: 'qa',
          parametersSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
          async run(input) { calls.push(input.value); return { success: true, value: input.value, observation: 'fixture-received' }; }
        };
        runtime.headlessRuntime.options.tools = [probe];
        runtime.headlessRuntime.toolsByName.clear();
        runtime.headlessRuntime.toolsByName.set(probe.name, probe);
        const release = attachUsageCapture(runtime.cleanSlateService, { onUsage: item => usage.push(item) });
        runtime.cleanSlateService.chat = transport.wrapChat(runtime.cleanSlateService.chat.bind(runtime.cleanSlateService));
        let finalText = '';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90_000);
        try {
          for await (const part of runtime.run('Call qa_echo once with value alpha, read its result, then reply fixture-received and the color filling the attached image, and finish.', controller.signal)) {
            if (part.type === 'chat_text') finalText += part.content || '';
          }
          assert.deepEqual(calls, ['alpha']);
          assert.match(finalText, /fixture-received/);
          assert.match(finalText, /red/i, 'SDK image attachment was not recognized');
          const cancel = new AbortController();
          const cancelTimer = setTimeout(() => cancel.abort(), 100);
          const began = Date.now();
          try { for await (const _part of runtime.run('Do not use tools. Count slowly from one to one thousand.', cancel.signal)) { /* private stream is not logged */ } } catch { /* SDK can terminate by throwing or ending the iterable. */ }
          finally { clearTimeout(cancelTimer); }
          assert.ok(cancel.signal.aborted && Date.now() - began < 5000, 'SDK cancellation was not bounded');
          assert.equal(calls.length, 1, 'Cancellation must not execute another tool');
          const totals = items => items.reduce((sum, item) => sum + item.totalTokens, 0);
          assert.ok(exactUsage.length >= 2, 'Tool call and continuation both need exact usage');
          assert.equal(usage.length, exactUsage.length, 'SDK usage must match completed transport calls exactly once');
          assert.equal(totals(usage), totals(exactUsage), 'SDK and transport usage totals differ');
          assert.equal(new Set(exactUsage.map(item => item.callId)).size, exactUsage.length);
          return {
            toolExecutions: calls.length, continuationVerified: true, imageVerified: true, cancellationVerified: true,
            usageReported: usage.every(item => Number.isSafeInteger(item.totalTokens) && item.totalTokens > 0),
            usageTransport: transport.version, completedUsageCalls: exactUsage.length, reportedTotalTokens: totals(exactUsage), accountingMatched: true
          };
        } finally {
          clearTimeout(timer); release(); runtime.dispose(); transport.dispose();
        }
      }
    });
    return report;
  } finally {
    await browser?.close();
  }
}

/** Persist a passing report exactly like the deploy script. Returns true when
 *  written; false (and leaves the previous receipt untouched) otherwise. */
export async function persistQualification(profile, report, { mkdir = fs.promises.mkdir, writeFile = fs.promises.writeFile } = {}) {
  if (!report?.passed) return false;
  const target = qualificationPath(profile);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, JSON.stringify(report, null, 2), { mode: 0o600 });
  return true;
}

/** One keeper iteration: decide, run, persist. Returns a short outcome string
 *  for logging/tests. Never throws. */
export async function keeperTick(profile, options = {}) {
  const waitMs = await timeUntilRequalification(profile, options);
  if (waitMs > 0) return 'current';
  let report;
  try {
    report = await (options.runQualification ?? runFullQualification)(profile);
  } catch (error) {
    return `error:${String(error?.message || error).slice(0, 200)}`;
  }
  const written = await persistQualification(profile, report, options);
  return written ? 'refreshed' : `failed:${Object.entries(report.capabilities || {}).filter(([, value]) => !value.passed).map(([key]) => key).join(',')}`;
}

/** Start the recurring keeper. Returns a stop() handle. Safe no-op when hybrid
 *  is disabled or no account key is configured. */
export function startQualificationKeeper({ logger, getConfigImpl = getConfig, tickMs = DEFAULT_TICK_MS, setTimeoutImpl = setTimeout, profile: profileOverride } = {}) {
  let stopped = false;
  let timer = null;
  const log = (level, event, data) => { try { logger?.[level]?.(event, data); } catch { /* logging must never break the keeper */ } };
  try {
    if (!hybridEnabled()) return { stop() { stopped = true; }, started: false, reason: 'disabled' };
    const profile = profileOverride ?? hybridProfile(getConfigImpl());
    if (!profile?.reasoner?.apiKey) return { stop() { stopped = true; }, started: false, reason: 'no-api-key' };
    const schedule = delay => {
      if (stopped) return;
      timer = setTimeoutImpl(async () => {
        try {
          const outcome = await keeperTick(profile);
          if (outcome === 'refreshed') log('info', 'hybrid.qualification.refreshed', { path: qualificationPath(profile) });
          else if (outcome !== 'current') log('warn', 'hybrid.qualification.issue', { outcome });
        } catch (error) {
          log('warn', 'hybrid.qualification.issue', { outcome: `error:${String(error?.message || error).slice(0, 200)}` });
        }
        schedule(tickMs);
      }, delay);
      timer.unref?.();
    };
    schedule(1_000);
    log('info', 'hybrid.qualification.keeper.started', { tickMs });
    return { stop() { stopped = true; if (timer) clearTimeout(timer); }, started: true };
  } catch (error) {
    log('warn', 'hybrid.qualification.keeper.start-failed', { error: String(error?.message || error).slice(0, 200) });
    return { stop() { stopped = true; }, started: false, reason: 'error' };
  }
}
