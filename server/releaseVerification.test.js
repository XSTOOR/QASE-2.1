import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyRelease } from '../scripts/verify-release.mjs';

test('release verification detects changed, missing, extra and unsafe source files', t => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-release-test-'));
 t.after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('qase-release-test-'));
  fs.rmSync(root, { recursive: true, force: true });
 });
 fs.mkdirSync(path.join(root, 'public'));
 const release = JSON.stringify({ releaseId: 'fixture-release' });
 fs.writeFileSync(path.join(root, 'public/release.json'), release);
 const manifest = { schema: 1, releaseId: 'fixture-release', files: [{ path: 'public/release.json', sha256: createHash('sha256').update(release).digest('hex') }] };
 const save = () => fs.writeFileSync(path.join(root, 'SOURCE_MANIFEST.json'), JSON.stringify(manifest));
 save();
 assert.equal(verifyRelease(root).files, 1);
 fs.writeFileSync(path.join(root, 'public/release.json'), '{}');
 assert.throws(() => verifyRelease(root), /changed/);
 fs.writeFileSync(path.join(root, 'public/release.json'), release);
 fs.writeFileSync(path.join(root, 'public/old-build.js'), 'old');
 assert.throws(() => verifyRelease(root), /Unexpected source/);
 fs.unlinkSync(path.join(root, 'public/old-build.js'));
 manifest.files.push({ path: '../escape', sha256: '' }); save();
 assert.throws(() => verifyRelease(root), /Unsafe/);
 manifest.files.pop(); manifest.files[0].path = 'public/missing.json'; save();
 assert.throws(() => verifyRelease(root), /Missing/);
});
