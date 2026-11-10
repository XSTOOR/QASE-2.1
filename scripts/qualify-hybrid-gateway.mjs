import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../server/config.js';
import { hybridProfile, qualificationPath } from '../server/hybridConfig.js';
import { probeHybridQualification } from '../server/hybridQualificationProbe.js';

const profile = hybridProfile(getConfig());
if (!profile.reasoner.apiKey) throw new Error('A configured server API key is required.');
const report = await probeHybridQualification(profile);
const target = qualificationPath(profile), temporary = target + '.' + randomUUID() + '.tmp';
await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
try {
  // A failed fresh probe also invalidates an older certificate; never keep a
  // known-incompatible gateway active. Replacement is atomic for all readers.
  await fs.writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, target);
} finally { await fs.rm(temporary, { force: true }); }
console.log(JSON.stringify({ path: target, ...report }, null, 2));
if (!report.passed) process.exitCode = 1;
