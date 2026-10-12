# Pipeline Phase 1 (selection model) review — 2026-10

Reviewed spec `.drytis/specs/pipeline-selection-model.md` against the Phase-1 implementation.

## Verdict: PASS overall (1 FAIL on test coverage, several WARNs)

## Verified good
- Explicit selection model (`createSelectionState/Store`, `qase.qaConfigSelection.v2`) in public/qaConfigMatrix.js; uncapped `computeExplicitSelection`.
- app.js has ZERO references to removed symbols (qaMatrixStore, deviceScopeSessionDeselections, unscopedExplicitSelection, computeCappedSelection, computeSelection, createDeselectionStore) — grep clean.
- Scope-as-view: `qaMatrixSetDeviceScope` (app.js:5152) only sets deviceScope + re-derives; banner + "← Back to all devices" exit at app.js:5264-5285.
- Filters touch only `qaMatrixState.filters` (qaMatrixWiring :5503-5521); summary built over full index → count filter-invariant.
- XSS: entire matrix render block (app.js 4914–5500) uses textContent/createElement only; no innerHTML.
- #14276 cap tests kept (5 tests, still passing against retained legacy helpers) + 10 new Phase-1 tests; suites: qaConfigMatrix 42/42, qaUiSelection 3/3, qaLauncher 4/4.
- Temporary per-request guard at MAX_RUN_CONFIGURATIONS in submit handler (app.js:5998) with honest "batching is coming" message — per spec.

## Gaps / WARNs (Phase 2 should address)
1. FAIL(test): Spec's "app-level tests for scope-as-view (scope does not mutate selection; exit works)" — NO test anywhere greps for scope-banner/scope-exit/qaMatrixSetDeviceScope. Implementation statically correct but untested.
2. `effectiveSelectionCount` (qaConfigMatrix.js:150) is literally `computeExplicitSelection(...).length` — materializes the array despite doc claiming "O(index) count without materializing". Not hot-path (not per keystroke), but the helper is dishonest + unused by app.js.
3. Chip tick on a family checkbox-OFF row calls `toggleBrowserFamily(next, index, family, true)` which clears ALL granular deselections in that family — so ticking one chip silently re-selects other chip-opted-out envIds in the family. Also deviates from spec edge "a deselected family contributes nothing regardless of chips" (tick re-enables the family — defensible explicit intent, but untested).
4. While scoped, `matrix.summary` and the TEST ON block (app.js:868-880) show the scoped device label instead of the true total — count unchanged but hidden; TEST ON naming the device may mislead users into thinking Start runs only that device (it submits the full selection).
5. Buttons rendered dynamically in qaMatrixRender, not static in index.html #qa-matrix-fieldset as spec letter says (functionally equivalent).
6. "37,244" AC not runtime-verified (catalog API requires auth; no browser tooling this session) — evidence is test-level (3,300-row uncapped assertion) only.
