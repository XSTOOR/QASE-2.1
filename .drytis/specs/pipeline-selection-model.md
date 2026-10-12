# Phase 1 — Selection model: explicit device/browser state, Select All, scope as view

## Goal
Replace the derived-and-capped selection model with explicit selection state so that
"Select All" selects the complete catalog (e.g. 37,244 configurations), selections survive
filtering/search/scope changes, and the 2,000 limit stops being a selection limit.

## Current state (recon evidence)
- No explicit selectedDeviceIds/selectedBrowserIds anywhere. Selection = full catalog index
  minus persisted deselection store, capped by `computeCappedSelection` slice at
  `public/qaConfigMatrix.js:147` (`MAX_RUN_CONFIGURATIONS = 2000`, `:437`).
- No global Select All configurations affordance; per-family checkboxes exist
  (`public/app.js:5183-5213`). Store `clear()` ("Select-all affordance") is dead code.
- Device row click → `qaMatrixSetDeviceScope` (`app.js:5260-5282`) which RESETS
  `deviceScopeSessionDeselections` + `unscopedExplicitSelection` (`:5136-5141`); scoped
  effective selection = that device only; `qaMatrixSetDeviceScope(null)` is unreachable
  from the UI (no exit-scope affordance).
- Server twin constant `MAX_MATRIX_CONFIGURATIONS = 2000` at `server/app.js:973` (422).

## Changes
**public/qaConfigMatrix.js**
- New selection model: `selectedDeviceKeys: Set<string>` (key `platform|manufacturer|device`),
  `selectedBrowserFamilies: Set<string>` (canonical 7), plus optional granular envId-level
  deselection overrides (reuse the deselection-store concept, scoped under the new model)
  so the existing version-chip UX keeps working.
- Effective configurations = catalog index rows where device key ∈ selectedDeviceKeys AND
  family ∈ selectedBrowserFamilies AND envId not granular-deselected. **No slice. No cap.**
- `computeCappedSelection` retired from the selection path (kept temporarily only if some
  other consumer exists — verify with grep; expected: tests only).
- Batch-size constant `MATRIX_BATCH_SIZE = 2000` introduced and exported; selection code
  must not reference it.
- New pure helpers: `selectAllDevices(index, store)`, `deselectAllDevices(...)`,
  `selectAllBrowsers(...)`, `deselectAllBrowsers(...)`, `effectiveSelectionCount(index, state)`
  (O(index) count without materializing arrays when possible).

**public/app.js**
- `qaMatrixState` gains the explicit sets; family checkboxes write to
  `selectedBrowserFamilies`; device checkboxes (new, one per device row) write to
  `selectedDeviceKeys`.
- "Select All Devices" / "Deselect All Devices" / "Select All Browsers" / "Deselect All
  Browsers" buttons in the matrix fieldset (`public/index.html` #qa-matrix-fieldset).
- Summary line shows the TRUE effective count (e.g. "37,244 configurations selected").
  Remove the "over the 2,000-configuration run limit" Start gate — Start is enabled for
  any non-empty valid selection (batching is Phase 2; until Phase 2 lands, keep a
  temporary guard at the OLD limit with an explicit message that batching is coming —
  coordinate: Phase 1 and 2 land together before E2E).
- Device-row CLICK becomes "scope as VIEW": filters the rendered tree to that device and
  shows a persistent "← Back to all devices" affordance. Scope MUST NOT mutate any
  selection set and MUST NOT reset explicit selections (remove the resets at
  `app.js:5136-5141`). `qaMatrixSetDeviceScope(null)` becomes reachable via the back
  affordance.
- Filters (platform/manufacturer/OS/orientation/search) affect rendering only — never the
  selection sets. Verify every filter handler.
- Legacy localStorage `qase.qaConfigDeselections`: on first load under the new model,
  treat legacy deselections as initial granular overrides (best-effort migration), then
  the new model owns state under a new storage key. Do not crash on legacy data.

## Acceptance criteria (true in the running app)
- [ ] "Select All Devices" + "Select All Browsers" shows the full catalog count (37,244), not 2,000
- [ ] Individual device/browser selection, multi-selection, deselect all, favorites all still work
- [ ] Applying/removing search or any filter does not change the selected-configuration count
- [ ] Clicking a device row shows that device scoped with a visible exit affordance; the selection count is unchanged by entering/leaving scope
- [ ] Selecting iPhone 15 Pro + Galaxy S24 + Pixel 9 + iPad Pro + Windows 11 + macOS simultaneously keeps all six selected
- [ ] All seven browser families (Chrome, Safari, Edge, Firefox, Opera, Brave, DuckDuckGo) appear in the checklist; DuckDuckGo remains honestly disabled/NOT_SUPPORTED

## Tests
- public/qaConfigMatrix.test.js: select-all/deselect-all helpers; count uncapped; filter
  non-interference; granular override interaction; legacy-store migration.
- public/app-level tests for scope-as-view (scope does not mutate selection; exit works).
- Keep every existing passing test green (adapt the #14276 cap tests to the new model —
  they encode user-visible behavior; update expectations honestly, do not delete coverage).

## Edge cases
- Empty catalog / catalog load error → selection state must survive a reload retry.
- Family deselect with granular ticks in that family (chip ticks override family OFF? define:
  granular overrides apply WITHIN selected devices×families; a deselected family contributes
  nothing regardless of chips).
- 37k-row count performance: count via index pass, not array materialization in render loop.
