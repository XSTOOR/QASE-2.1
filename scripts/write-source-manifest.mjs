import { writeSourceManifest } from './release-source.mjs';
import { verifyRelease } from './verify-release.mjs';

writeSourceManifest(process.cwd());
const result = verifyRelease(process.cwd());
console.log(`Generated and verified ${result.releaseId}: ${result.files} source files.`);
