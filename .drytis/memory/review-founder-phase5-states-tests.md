# Review: Founder Mode Phase 5 (states, errors, test coverage) — Ticket spec founder-mode-states-tests.md

Verdict: 2 PASS / 0 FAIL / 3 WARN. Suite: 858 tests, 838 pass, 0 fail, 20 skipped (matches expected). node --check clean on all touched files.

## Findings

1. WARN (substantive) — The new "No supported recommendations yet" empty state is implemented correctly (founderView.js:405-416, verified rendering via a DOM-stub harness) but is **unreachable through the normal pipeline**: `normalizeFounderReport` (founderSchema.js:213) rejects any report with <3 recommendations, so a finalized report with 0 recommendations cannot exist, and `renderFounderPriorities` only runs for finalized reports. Spec conflict: Phase 5 lists "no sufficiently supported recommendations" as a reachable UI state; Phase 2 deliberately set MIN_RECOMMENDATIONS=3 (evidence-bound count). Implementer resolved toward Phase 2. Needs leader decision: either allow publishing a 0-rec report (relax min or add an explicit empty-report path) or amend the spec.

2. WARN (minor) — The new empty-state copy is **not pinned by any test**. founderStates.test.js pins lifecycle copy (complete/running/waiting/error/interrupted/paused/ready) but nothing asserts the "No supported recommendations yet" copy in founderView.js. Spec's test list ("founderUi.test.js / pins — ... states copy") only partially covered.

3. WARN (minor, test design) — founderQuality.test.js is self-referential: fixtures supply both the model-shaped input AND the asserted product-specific strings (e.g. the "integration preference" test just asserts the fixture's own `proposedFeature` text contains "integrat|vendor|existing"). It genuinely exercises createFounderState → populateObservations → finishFounderReview → markdown with schema-accurate shapes and proves the two outputs don't overlap, but it validates pipeline mechanics, not model behavior (impossible without live LLM — correctly excluded). Fine as a regression harness; not a real quality gate on model output.

## Verified good
- All lifecycle states pinned by founderStates.test.js (6 tests): actionable copy, evidence-preserved, resume guidance.
- Handoff states (pending/succeeded/failed/unavailable) rendered by renderHandoffStatus (Phase 4, unchanged).
- finish_founder_review returns actionable structured errors (founderTools.js:210-232): readiness errors list missing categories/unfinished todos; validation errors surface the TypeError message with field names.
- founderQuality fixtures use schema-accurate snake_case shapes (unlike the Phase 4 fixtures that masked the field-drop bug).
- No live LLM/network in tests; suite duration ~24s.
- Empty state rendering driven directly: distinct section, actionable copy, explicitly not an error.

## Still-open prior-phase items (for tickets)
- Phase 2: `upgradeLegacyReport` dead code (never called from load path).
- Phase 3: regeneration clears ALL selections (surviving ids too); app.js comment claims owner enforcement that doesn't exist on GET/PATCH /api/founder/state.
- Phase 4 (closed): payload field coverage, founder target wiring, pending expiry — all fixed and pinned.
- `.drytis/patterns.md` does not exist in this repo; pattern conformance judged against surrounding code style.
