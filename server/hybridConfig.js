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
export const hybridEnabled = () => process.env.QASE_HYBRID_QA_ENABLED === 'true';
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

/** Credential-free availability for the launcher. Never return raw gateway or
 * configuration errors; qualification and the feature flag remain mandatory. */
export function hybridAvailability(profile, { enabled = hybridEnabled(), readQualification = loadQualification } = {}) {
  if (!enabled) return { enabled: false, qualified: false, available: false, status: 'disabled', reason: 'Hybrid QA is disabled by the server operator.' };
  try {
    const report = readQualification(profile);
    return { enabled: true, qualified: true, available: true, status: 'ready', checkedAt: report.checkedAt, expiresAt: report.checkedAt + 86400000 };
  } catch (error) {
    const expired = error.code === 'HYBRID_QUALIFICATION_EXPIRED';
    return { enabled: true, qualified: false, available: false, status: expired ? 'qualification_expired' : 'qualification_required',
      reason: expired ? 'Hybrid QA is unavailable because its compatibility check expired. The server operator must rerun the gateway checks; refresh this page after they pass.' : 'Hybrid QA is unavailable until the server operator completes gateway qualification for the configured models and account.' };
  }
}

export function loadQualification(profile) {
  let report;
  try { report = JSON.parse(readFileSync(qualificationPath(profile), 'utf8')); }
  catch {
    // Compatibility with the initial local qualification report. Its exact
    // credential/profile identity is still validated before it can be used.
    if (!process.env.QASE_HYBRID_QUALIFICATION_FILE) try { report = JSON.parse(readFileSync('.qase/qualifications/hybrid.json', 'utf8')); } catch { /* fail closed */ }
  }
  validateQualification(profile, report);
  return report;
}

export function qualificationPath(profile) {
  return path.resolve(process.env.QASE_HYBRID_QUALIFICATION_FILE || path.join('.qase', 'qualifications', 'hybrid', `${profileIdentity(profile)}.json`));
}

export function selectQaExecutionMode(value, enabled = hybridEnabled()) {
  if (value === undefined) return enabled ? 'hybrid' : 'legacy';
  // Explicit API rollback remains available; the launcher always sends hybrid.
  if (value === 'legacy') return 'legacy';
  if (value !== 'hybrid') throw new TypeError('Unknown QA execution mode.');
  if (!enabled) throw new TypeError('Hybrid QA is disabled for new runs.');
  return 'hybrid';
}
