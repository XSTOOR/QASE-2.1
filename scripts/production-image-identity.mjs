import assert from 'node:assert/strict';

/** Check image metadata before booting a disposable canary or promoting it.
 * The archive checksum is transport integrity, not a registry image digest. */
export function verifyProductionImageIdentity(info, release, expectedRevision) {
  assert.equal(info?.Config?.User, 'node', 'The image must run as the non-root service user.');
  const labels = info.Config.Labels ?? {};
  assert.equal(labels['org.opencontainers.image.version'], release.releaseId, 'Wrong image release ID.');
  if (expectedRevision !== undefined) {
    assert.match(expectedRevision, /^[a-f0-9]{40}$/, 'An expected full Git commit SHA is required.');
    assert.equal(labels['org.opencontainers.image.revision'], expectedRevision, 'Wrong image source commit.');
  }
  return { releaseId: release.releaseId, sourceRevision: labels['org.opencontainers.image.revision'] ?? null, imageId: info.Id };
}
