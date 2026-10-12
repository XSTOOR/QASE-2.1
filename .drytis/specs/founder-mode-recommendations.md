# Phase 2 · Structured, prioritized recommendations (server-validated)

## Goal
Extend the existing `recommendations[]` tool schema and `founderSchema.js` normalization so every recommendation carries the full required structure, is ranked, deduplicated, and validated server-side.

## Files to change
- `server/founderSchema.js` — extend recommendation normalization. Required per recommendation:
  - stable `id` within the set (already exists)
  - `title`, `opportunity` (specific problem/opportunity), `evidence` (referencing observation IDs)
  - `proposedFeature` (feature or integration to build)
  - `whyItMatters` (product-specific reasoning)
  - `intendedOutcome` (business outcome, no numerical promises — validator rejects numeric claims of uplift/revenue)
  - `priority` (rank order 1..N) + `priorityReason`
  - `effort`: `small | medium | large`
  - `dependencies` (ids or external prerequisites, may be empty)
  - `implementationScope` (concrete scope)
  - `acceptanceCriteria` (testable, min 2)
  - `assumptions` (may be empty)
  - backward-tolerant: old saved reports lacking new fields still load (normalizer fills placeholders, flags set version).
- `server/founderTools.js` — update `founderReportToolSchema` + `finish_founder_review` prompt guidance: rank in sensible implementation order, no duplicates/contradictions, count matched to evidence (drop the current hard min of 6 — generate only what evidence supports; min 3).
- `server/founderService.js` — dedupe/contradiction post-check; report `setVersion` + `generatedAt` stamped on the recommendation set.
- `server/founderPrompt.js` — guidance: prefer existing integrations over internal rebuilds; encouraging practical tone; no success promises.
- Tests: `server/founderSchema.test.js` (extend), `server/founderTools.test.js`, `server/founderService.test.js`.

## Acceptance criteria
- [ ] Server rejects (via tool-call validation error path) reports with recommendations missing required fields, numeric promises, or duplicate/contradictory items.
- [ ] Every saved recommendation set has stable ids, priority order, effort enum, dependencies, scope and acceptance criteria.
- [ ] Recommendation count reflects available evidence; a thin-context run yields fewer items without padding.
