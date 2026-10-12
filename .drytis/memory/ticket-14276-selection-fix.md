# Ticket #14276 — "Devices are not getting selected" (Start QA matrix)

## Root cause (two defects, both in public/app.js + model layer)
1. **Scoped mode:** version-chip change handler wrote to the PERSISTED deselection store (`qaMatrixStore`) even when a device scope was active. Scoped effective selection reads `deviceScopeSessionDeselections` only → chip clicks were silent no-ops.
2. **Unscoped mode:** effective selection = `computeSelection(index, store).slice(0, 2000)` (#15323). The catalog index is Android-first (38,762 rows, 176 devices), so the capped default was 100% Android. Ticking an iPhone/iPad chip was a `reselect()` no-op (envId never deselected) and the slice discarded it → click swallowed.

## Fix
- `public/qaConfigMatrix.js`: new `computeCappedSelection(configurations, deselectionStore, explicitSelection)` — deselections applied first, explicit ticks pinned BEFORE the 2,000 cap slice, remainder in catalog order. Empty explicit set ≡ old behavior (regression-tested).
- `public/app.js`: `qaMatrixState.unscopedExplicitSelection` (session Set, never persisted, cleared on scope change + catalog error). Chip and family handlers now write `deviceScopeSessionDeselections` when scoped; persisted store + explicit set when unscoped.
- 5 regression tests in `public/qaConfigMatrix.test.js` (all green; public suite 210/210).

## Known accepted UX (reviewer WARN, tested live)
- Unscoped family re-tick (e.g. Chrome, 8,602 rows) now honestly exceeds the cap → "Too many configurations selected (8,602)…" + Start disabled. Pre-fix this silently returned a 2,000-Android slice. Gate wording matches server 422 (server/app.js).

## Verification
infra_verifier PASS · reviewer PASS · tester 6/6 PASS post-fix (out-of-cap chip tick displaces an Android tail row: Chrome 2000→1999, Brave 0→1; scoped ticks ±1; no new console errors).

## Related infra note
`QASE_BROWSER_ALLOWED_PRIVATE_HOSTS` env key hardcodes the literal preview hostname — needs manual refresh on preview-host rotation (see memory meeting-private-host-allowlist.md).

## Open follow-ups (NOT this ticket)
- "Change device" button (TEST ON, while scoped) appears inert — no DOM mutation.
- Device-row vs nested chip hit areas overlap; clicking via row's accessible name can land on a version chip.
