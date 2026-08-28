# Drytis backend adapter

This directory is the portable, server-only boundary between Drytis Studio and
QASE. Copy or publish the directory as one package; `qaseClient.js` deliberately
depends only on `protocol.js` and Node built-ins.

Do not import either module into the Studio browser bundle. The 32-byte HMAC key
must remain in the Drytis backend secret store.

```js
import { createDrytisQaseClient } from './integrations/drytis/qaseClient.js';

const qase = createDrytisQaseClient({
  qaseOrigin: process.env.QASE_CELL_ORIGIN,
  signingKey: process.env.QASE_DRYTIS_HMAC_KEY
});

const review = await qase.createReview({
  schemaVersion: qase.schemaVersion,
  externalReviewId,
  project: { id: qaseProjectId, name, revision },
  projectContext: { applicationType, primaryLanguage, frameworks },
  containerUrl,
  requestedChecks: { blackBox: true, whiteBox: true },
  sourceSnapshot
}, {
  idempotencyKey: `qase:create:${externalReviewId}`,
  correlationId
});
```

Drytis should render only `qase.launchDescriptor(review)`, persist the review to
project/revision/cell mapping, and use `waitForReview` or `getReview` as the
canonical recovery path. `buildRepairBundle` returns revision-bound suggestions
for a human-approved Drytis repair workflow; it never edits code.

The complete request/response schemas, security rules, source exclusions, and
rollout gates are in:

- `docs/drytis-integration.openapi.yaml`
- `docs/drytis-integration.md`
- `docs/drytis-studio-integration-architecture.md`

