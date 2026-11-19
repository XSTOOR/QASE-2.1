/**
 * Model profile for the qualified SQA/Founder "mode reasoning" runtime
 * (reasoner + JEV classifier through the SDK usage transport). QA mode does
 * not use this file; it has its own optional model layer in server/qa/models.js.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { JEV_ENDPOINT, JEV_MODEL } from './jevClient.js';

export const HYBRID_VERSION = 1;
export const HYBRID_USAGE_TRANSPORT = 'qase-loopback-usage-v1';
export const OPUS_MODEL = 'drytis/claude-opus-4.7';
export const OPUS_ENDPOINT = 'https://llm.drytis.ai/v1/chat/completions';
export const HYBRID_SDK_VERSION = JSON.parse(readFileSync(path.join(path.dirname(createRequire(import.meta.url).resolve('@cleanslate/sdk')), '..', 'package.json'), 'utf8')).version;
export const REQUIRED_CAPABILITIES = ['text', 'streaming', 'nativeTools', 'multipleTools', 'continuation', 'cancellation', 'timeout', 'usage', 'structured', 'image', 'sdkLoop', 'sdkUsage', 'jev'];
const limit = (value, fallback, max) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.min(max, Math.floor(Number(value))) : fallback;

export function hybridProfile(settings = {}, env = process.env) {
  // Reuse the effective, account-scoped server key; all destinations are fixed.
  // No global role key may override another account's effective credentials.
  const profile = {
    version: HYBRID_VERSION, sdkVersion: HYBRID_SDK_VERSION, usageTransport: HYBRID_USAGE_TRANSPORT,
    reasoner: { model: OPUS_MODEL, endpoint: OPUS_ENDPOINT, apiKey: settings.apiKey || '' },
    classifier: { model: JEV_MODEL, endpoint: JEV_ENDPOINT, apiKey: settings.apiKey || '' },
    allowWithoutClassifier: env.QASE_HYBRID_ALLOW_WITHOUT_JEV === 'true',
    budgets: {
      reasonerCalls: limit(env.QASE_HYBRID_OPUS_CALLS, 60, 200), classifierCalls: limit(env.QASE_HYBRID_JEV_CALLS, 40, 100),
      reasonerTokens: limit(env.QASE_HYBRID_OPUS_TOKENS, 300000, 2000000), classifierTokens: limit(env.QASE_HYBRID_JEV_TOKENS, 100000, 500000),
      outputTokens: limit(env.QASE_HYBRID_OUTPUT_TOKENS, 4096, 16000), browserActions: limit(env.QASE_HYBRID_BROWSER_ACTIONS, 180, 1000),
      durationMs: limit(env.QASE_HYBRID_DURATION_MS, 900000, 3600000), reasonerTimeoutMs: limit(env.QASE_HYBRID_OPUS_TIMEOUT_MS, 90000, 180000),
      classifierTimeoutMs: limit(env.QASE_HYBRID_JEV_TIMEOUT_MS, 30000, 60000)
    }
  };
  const autonomousCeilings = { reasonerTokens: 2000000, classifierTokens: 500000, reasonerCalls: 200, classifierCalls: 100, browserActions: 1000, durationMs: 3600000 };
  const budgetVariables = { reasonerTokens: 'QASE_HYBRID_OPUS_TOKENS', classifierTokens: 'QASE_HYBRID_JEV_TOKENS', reasonerCalls: 'QASE_HYBRID_OPUS_CALLS', classifierCalls: 'QASE_HYBRID_JEV_CALLS', browserActions: 'QASE_HYBRID_BROWSER_ACTIONS', durationMs: 'QASE_HYBRID_DURATION_MS' };
  profile.autonomy = { enabled: env.QASE_HYBRID_AUTONOMOUS_COMPLETION !== 'false',
    limits: Object.fromEntries(Object.entries(autonomousCeilings).map(([key, ceiling]) => [key, env[budgetVariables[key]] !== undefined ? profile.budgets[key] : ceiling])),
    maxPages: limit(env.QASE_HYBRID_MAX_PAGES, 40, 80) };
  return profile;
}

export function profileIdentity(profile) {
  return createHash('sha256').update(JSON.stringify({ version: profile.version, sdk: profile.sdkVersion, usageTransport: profile.usageTransport,
    reasoner: { model: profile.reasoner.model, endpoint: profile.reasoner.endpoint }, classifier: { model: profile.classifier.model, endpoint: profile.classifier.endpoint },
    credential: createHash('sha256').update(profile.reasoner.apiKey).digest('hex') })).digest('hex');
}

export function validateQualification(profile, report, now = Date.now()) {
  if (!profile.reasoner.apiKey) throw new Error('Hybrid QA needs a configured account API key.');
  if (!report || report.profileIdentity !== profileIdentity(profile) || report.sdkVersion !== HYBRID_SDK_VERSION ||
      !Number.isFinite(report.checkedAt) || now < report.checkedAt ||
      REQUIRED_CAPABILITIES.some(key => report.capabilities?.[key]?.passed !== true)) {
    throw new Error('Hybrid QA is blocked: a current successful gateway and CleanSlate qualification for this model/key is required.');
  }
  if (now - report.checkedAt > 86400000) throw Object.assign(new Error('Hybrid QA is blocked: gateway qualification expired; rerun the gateway and CleanSlate compatibility checks.'), { code: 'HYBRID_QUALIFICATION_EXPIRED' });
  return true;
}

export function loadQualification(profile) {
  let report;
  try { report = JSON.parse(readFileSync(qualificationPath(profile), 'utf8')); }
  catch {
    // Compatibility with the initial local qualification report. Its exact
    // credential/profile identity is still validated before it can be used.
    if (!process.env.QASE_HYBRID_QUALIFICATION_FILE && !process.env.QASE_HYBRID_QUALIFICATION_DIR && process.env.QASE_EXECUTION_MODE !== 'distributed') try { report = JSON.parse(readFileSync('.qase/qualifications/hybrid.json', 'utf8')); } catch { /* fail closed */ }
  }
  validateQualification(profile, report);
  return report;
}

export function qualificationPath(profile) {
  // Distributed API/worker pods use separate ephemeral .qase directories.
  // Their existing shared evidence volume must also carry the certificates.
  const directory = process.env.QASE_HYBRID_QUALIFICATION_DIR ||
    (process.env.QASE_EXECUTION_MODE === 'distributed' && process.env.QASE_ARTIFACT_DIR
      ? path.join(process.env.QASE_ARTIFACT_DIR, 'qualifications', 'hybrid')
      : path.join('.qase', 'qualifications', 'hybrid'));
  return path.resolve(process.env.QASE_HYBRID_QUALIFICATION_FILE || path.join(directory, `${profileIdentity(profile)}.json`));
}
