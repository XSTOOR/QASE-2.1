import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSourceManifest } from '../scripts/release-source.mjs';
import { verifyRelease } from '../scripts/verify-release.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-source-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'public'));
  fs.writeFileSync(path.join(root, 'public/release.json'), JSON.stringify({ releaseId: 'source-fixture', uiVersion: '20261027-3' }));
  fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM fixture\n');
  return { root, generate: () => writeSourceManifest(root, { directories: ['public'], files: ['Dockerfile'] }) };
}
test('source manifests are deterministic, exclude private root state and detect source changes', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, '.env'), 'PRIVATE=not-for-release');
  const first = f.generate(); assert.equal(verifyRelease(f.root).files, 2);
  assert.deepEqual(f.generate(), first);
  assert.equal(first.files.some(file => file.path === '.env'), false);
  fs.writeFileSync(path.join(f.root, 'public/new.js'), 'export const revised=true;\n');
  assert.throws(() => verifyRelease(f.root), /Unexpected/);
  f.generate(); assert.equal(verifyRelease(f.root).files, 3);
});
test('manifest generation refuses nested secrets, symbolic links and noncanonical source instead of rewriting files', t => {
  const f = fixture(t), secret = path.join(f.root, 'public/.env.production');
  fs.writeFileSync(secret, 'PRIVATE=not-for-release'); assert.throws(f.generate, /Private\/generated/); fs.unlinkSync(secret);
  const link = path.join(f.root, 'public/linked.js'); fs.symlinkSync('../Dockerfile', link);
  assert.throws(f.generate, /symbolic link/); fs.unlinkSync(link);
  const crlf = path.join(f.root, 'public/crlf.js'); fs.writeFileSync(crlf, 'export const fixture=true;\r\n');
  assert.throws(f.generate, /LF line endings/);
  assert.ok(fs.readFileSync(crlf, 'utf8').endsWith('\r\n'));
});
test('production image identity and verified-source build match the checked-in release', async () => {
  const release = JSON.parse(fs.readFileSync(new URL('../public/release.json', import.meta.url)));
  const docker = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.ok(docker.includes(`ARG QASE_RELEASE_ID=${release.releaseId}`));
  assert.match(docker, /AS verified-source/); assert.match(docker, /RUN node scripts\/verify-release\.mjs/);
  assert.match(docker, /COPY --from=verified-source/);
  const workflow = fs.readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8');
  assert.match(workflow, /test:production-image/); assert.match(workflow, /actions\/upload-artifact/);
});
