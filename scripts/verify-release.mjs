import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function verifyRelease(root) {
 const manifest = JSON.parse(fs.readFileSync(path.join(root, 'SOURCE_MANIFEST.json'), 'utf8'));
 if (manifest.schema !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid release manifest.');
 const seen = new Set();
 for (const entry of manifest.files) {
  if (typeof entry.path !== 'string' || entry.path.includes('\\') || entry.path.split('/').some(p => !p || p === '..' || p === '.') || path.isAbsolute(entry.path) || /^[A-Za-z]:/.test(entry.path) || seen.has(entry.path)) throw new Error('Unsafe or duplicate manifest path.');
  seen.add(entry.path);
  const target = path.join(root, entry.path);
  if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink()) throw new Error(`Missing or unsafe release file: ${entry.path}`);
  const actual = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  if (actual !== entry.sha256) throw new Error(`Release file changed: ${entry.path}`);
 }
 const release = JSON.parse(fs.readFileSync(path.join(root, 'public/release.json'), 'utf8'));
 if (manifest.releaseId !== release.releaseId) throw new Error('Release identity mismatch.');
 function inspect(directory) {
  if (!fs.existsSync(directory)) return;
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Unexpected source symbolic link.');
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
   const full = path.join(directory, item.name);
   if (item.isSymbolicLink()) throw new Error('Unexpected source symbolic link.');
   if (item.isDirectory()) inspect(full);
   else if (item.name.startsWith('.env') && item.name !== '.env.example') continue;
   else if (!seen.has(path.relative(root, full).replaceAll('\\', '/'))) throw new Error(`Unexpected source file: ${path.relative(root, full)}`);
  }
 }
 for (const directory of ['public', 'server', 'scripts', 'docs', 'deploy', 'load', 'integrations', '.github']) inspect(path.join(root, directory));
 return { releaseId: manifest.releaseId, files: manifest.files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const result = verifyRelease(path.resolve(process.argv[2] || process.cwd()));
 console.log(`Verified ${result.releaseId}: ${result.files} source files match SHA-256.`);
}
