import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// The repository, source ZIP and verified Docker source use one inventory.
export const RELEASE_DIRECTORIES = ['public', 'server', 'scripts', 'docs', 'deploy', 'load', 'integrations', '.github'];
export const RELEASE_FILES = ['package.json', 'package-lock.json', 'README.md', 'DEPLOYMENT_PROMPT.md', 'RELEASE_NOTES.md', '.env.example',
  '.gitignore', '.gitattributes', '.dockerignore', '.nvmrc', 'Dockerfile', 'run-jev.command'];

export function writeSourceManifest(root, { directories = RELEASE_DIRECTORIES, files = RELEASE_FILES } = {}) {
  const entries = [];
  function collect(relative) {
    const target = path.join(root, relative), stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Release source contains a symbolic link: ${relative}`);
    const name = path.basename(relative);
    if ((name.startsWith('.env') && name !== '.env.example') || ['.qase', '.git', 'node_modules', '.tooling', 'test-results'].includes(name) || /\.(?:pem|key|p12|pfx|log|zip)$/i.test(name)) throw new Error(`Private/generated file in release source: ${relative}`);
    if (stat.isDirectory()) {
      for (const item of fs.readdirSync(target).sort()) collect(path.join(relative, item));
    } else if (stat.isFile()) {
      const bytes = fs.readFileSync(target), text = bytes.toString('utf8');
      if (!bytes.includes(0) && Buffer.from(text, 'utf8').equals(bytes) && text.includes('\r\n')) throw new Error(`Release text must use LF line endings: ${relative}`);
      entries.push({ path: relative.replaceAll('\\', '/'), sha256: createHash('sha256').update(bytes).digest('hex') });
    } else throw new Error(`Unsupported release source entry: ${relative}`);
  }
  for (const entry of [...directories, ...files]) collect(entry);
  const release = JSON.parse(fs.readFileSync(path.join(root, 'public/release.json'), 'utf8'));
  if (!release.releaseId || !release.uiVersion) throw new Error('Release identity and UI version are required.');
  const manifest = { schema: 1, releaseId: release.releaseId, files: entries.sort((a, b) => a.path.localeCompare(b.path)) };
  fs.writeFileSync(path.join(root, 'SOURCE_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
