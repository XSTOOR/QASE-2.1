# Phase 2 — Batching: parent runs, ≤2,000 batches, idempotent submission

## Goal
"Run All" on any-size selection: >2,000 configurations split into batches of ≤2,000, all
belonging to one logical parent QA Run; no oversized POST, no duplicate jobs.

## Current state (recon)
- POST /api/qa-matrix-runs hard-422s over 2,000 (`server/app.js:973-981`); body limit 8 MB
  (route-scoped at `:259`). Frontend mirrors the cap (`public/app.js:5878-5894`).
- matrixService.create makes ONE run with items[] ≤ 2,000 (`matrixService.js:30-456`),
  persisted to a JSON file, debounced per item.
- No parent-run/batch concept anywhere. No idempotency keys.

## Changes
**public/qaConfigMatrix.js + public/app.js**
- Client-side batch plan: `planBatches(envIds, batchSize=2000)` → ordered stable batches.
- Submit: if selection ≤ 2,000 → existing single POST (unchanged shape). If larger →
  create parent first (POST /api/qa-matrix-runs with `parentId: null, configurationEnvIds:
  []` + full metadata + `totalPlanned`), then POST each batch with `parentId` and a stable
  `batchKey` (e.g. hash(parentId + sorted envIds slice)). Sequential batch creation,
  visible progress ("Creating batch 2/19…"). Never one giant payload.
- Retain the 8 MB body-limit route scoping; each batch stays well under it.

**server/app.js**
- POST /api/qa-matrix-runs accepts optional `parentId` + `batchKey`; validates ≤2,000 per
  request (KEEP the per-request cap — it is now the batch limit, as intended).
- Parent run record: lightweight aggregate (status, totalPlanned, batch ids, aggregate
  counters). GET /api/matrix-runs/:id returns parent view when the id is a parent
  (aggregated item rows across batches, joined for the results board).

**server/matrixService.js**
- `createParentRun({ targetUrl, tests, scope, totalPlanned })` → run with
  `kind: 'parent'`, no items.
- `createBatch(parentId, batchKey, envIds, ...)` → run with `kind: 'batch'`, `parentId`;
  **idempotency**: same (parentId, batchKey) returns the existing batch (200-style) instead
  of duplicating. Stable envId→item mapping (same as today's launcher mode).
- Aggregate counters maintained on parent as batches/children report (or computed on read —
  prefer computed-on-read first; persistence of aggregates only if perf demands).

**Backward compatibility**
- Existing single-run shape must remain valid (all existing tests, both stores). Parent
  reads fall back to plain behavior when kind is undefined.
- Both stores: JSON file store AND postgres (server/postgres/) — schema/migration only if a
  parent column is needed; prefer additive nullable columns (parent_id, kind, batch_key).

## Acceptance criteria
- [ ] Selecting 5,250 configurations and starting creates 1 parent + 3 batches (2,000/2,000/1,250)
- [ ] Re-submitting the same batchKey creates no duplicate items/jobs
- [ ] A network failure during batch 3 creation leaves batches 1-2 intact and retry-safe (idempotent retry completes the run)
- [ ] The per-request 2,000 cap still 422s a request that itself exceeds 2,000 envIds
- [ ] 37,244-selection "Run All" enqueues across 19 batches without any oversized request (verified by payload size logging/test)

## Tests
- server/matrixService.test.js: parent+batch creation, idempotent batchKey, aggregate read.
- server/app.test.js: POST with parentId/batchKey; over-cap per-request still 422.
- public/qaConfigMatrix.test.js: planBatches edge cases (0, 1, exactly 2000, 2001, 5250).
- Regression: all existing matrixApi/matrixService/app tests pass.

## Edge cases
- Selection size exactly 2,000 → single run, no parent (or parent with 1 batch — choose the
  single-run path for simplicity, document it).
- Duplicate envIds across batches must be impossible by construction (disjoint slices);
  server still validates uniqueness within a batch.
- Parent with zero executable configurations → honest empty aggregate, not an error.
