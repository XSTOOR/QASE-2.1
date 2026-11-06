import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyProductionImageIdentity } from '../scripts/production-image-identity.mjs';

test('image promotion rejects a different commit even when its release label matches', () => {
  const revision = 'a'.repeat(40), release = { releaseId: 'fixture-release' };
  const image = { Id: 'sha256:fixture-image', Config: { User: 'node', Labels: {
    'org.opencontainers.image.version': release.releaseId, 'org.opencontainers.image.revision': revision
  } } };
  assert.equal(verifyProductionImageIdentity(image, release, revision).sourceRevision, revision);
  assert.throws(() => verifyProductionImageIdentity(image, release, 'b'.repeat(40)), /Wrong image source commit/);
  assert.throws(() => verifyProductionImageIdentity(image, release, 'latest'), /full Git commit SHA/);
  assert.throws(() => verifyProductionImageIdentity(image, { releaseId: 'old-release' }, revision), /Wrong image release/);
  assert.throws(() => verifyProductionImageIdentity({ ...image, Config: { ...image.Config, User: 'root' } }, release, revision), /non-root/);
});
