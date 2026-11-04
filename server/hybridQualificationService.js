import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hybridAvailability, hybridEnabled, loadQualification, profileIdentity, qualificationPath, REQUIRED_CAPABILITIES, validateQualification } from './hybridConfig.js';
import { PublicInputError } from './publicErrors.js';

export async function saveHybridQualification(profile, report) {
  validateQualification(profile, report);
  if (report.passed !== true) throw new Error('Qualification did not pass.');
  const target = qualificationPath(profile), temporary = `${target}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Explicit operator maintenance, never a side effect of a configuration GET.
 * At most one probe per process; identical requests share its job. No keys,
 * provider errors or model prose enter the public status. */
export function createHybridQualificationService({
  qualify = async (profile, options) => (await import('./hybridQualificationProbe.js')).probeHybridQualification(profile, options),
  read = loadQualification, save = saveHybridQualification, enabled = hybridEnabled, now = Date.now
} = {}) {
  const jobs = new Map();
  let active;
  function availability(profile) {
    const base = hybridAvailability(profile, { enabled: enabled(), readQualification: read });
    if (!base.enabled) return base;
    const job = jobs.get(profileIdentity(profile));
    if (job?.status === 'running') return { ...base, available: false, qualified: false, status: 'qualification_running', startedAt: job.startedAt,
      reason: 'Checking model compatibility. Your website, browser and selected checks are saved.' };
    if (!base.available && job?.status === 'failed') return { ...base, status: 'qualification_failed', retryAt: job.retryAt,
      reason: `Model compatibility checks could not be completed${job.failedChecks.length ? ` (${job.failedChecks.join(', ')})` : ''}. Testing remains blocked. Retry after a minute, or ask the operator to review the gateway and browser installation.` };
    return base;
  }
  function start(profile) {
    if (!enabled()) throw new PublicInputError('Hybrid QA is disabled by the server operator.', 409);
    if (!profile.reasoner.apiKey) throw new PublicInputError('Configure an account API key before checking model compatibility.', 409);
    const key = profileIdentity(profile), job = jobs.get(key);
    if (job?.status === 'running') return availability(profile);
    if (availability(profile).available) return availability(profile);
    if (job?.retryAt > now()) return availability(profile);
    if (active) throw new PublicInputError('Another model compatibility check is running. Retry shortly.', 429);
    // Bound records even when an operator repeatedly rotates account keys.
    if (jobs.size >= 64) for (const [id, previous] of jobs) {
      if (previous.status !== 'running') { jobs.delete(id); break; }
    }
    const next = { status: 'running', startedAt: now(), failedChecks: [] };
    jobs.set(key, next);
    const work = Promise.resolve().then(async () => {
      try {
        const report = await qualify(profile, { signal: AbortSignal.timeout(180000) });
        next.failedChecks = REQUIRED_CAPABILITIES.filter(name => report?.capabilities?.[name]?.passed !== true);
        if (report?.passed !== true) throw new Error('Gateway checks failed.');
        validateQualification(profile, report, now());
        await save(profile, report);
        next.status = 'ready';
      } catch {
        next.status = 'failed'; next.retryAt = now() + 60000;
      } finally { active = undefined; }
    });
    active = work;
    return availability(profile);
  }
  return { start, availability, async waitForIdle() { await active; } };
}

export const hybridQualificationService = createHybridQualificationService();
