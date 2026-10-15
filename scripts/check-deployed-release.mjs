// Read-only public checks. Run from the freshly extracted, verified ZIP root.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyRelease } from './verify-release.mjs';
const verified = verifyRelease(process.cwd());
const origin = new URL(process.argv[2] || 'https://qase.drytis.com');
if (origin.protocol !== 'https:') throw new Error('Production verification requires HTTPS.');
const manifest = JSON.parse(fs.readFileSync('SOURCE_MANIFEST.json', 'utf8'));
async function get(route) {
 const response = await fetch(new URL(route, origin), { signal: AbortSignal.timeout(20000), headers: { 'cache-control': 'no-cache' }, redirect: 'error' });
 if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
 return response;
}
for (const route of ['/healthz', '/readyz']) await get(route);
const release = await (await get('/release.json')).json();
if (release.releaseId !== verified.releaseId) throw new Error('Wrong production release.');
for (const file of ['index.html', 'app.js', 'runCard.css', 'brand.css', 'auth.css', 'release.json']) {
 const entry = manifest.files.find(item => item.path === `public/${file}`);
 if (!entry) throw new Error(`Asset absent from manifest: ${file}`);
 const bytes = new Uint8Array(await (await get(`/${file}`)).arrayBuffer());
 if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Stale or modified production asset: ${file}`);
}
console.log(`Verified live release and six asset hashes: ${verified.releaseId}`);
