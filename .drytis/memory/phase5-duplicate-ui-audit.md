# Pipeline Phase 5 — duplicate-UI audit (read-only), QASE-2.1 /workspace

Device/browser selection surfaces found (6 distinct workflows + 2 legacy dupes):
1. QA launcher matrix #qa-matrix-fieldset (index.html:769) → GET /api/qa-configurations, POST /api/qa-matrix-runs — KEEP.
2. ONE device picker #device-picker (index.html:1331, app.js:7265; matrixSidebar/matrixColumns/devicePicker) → GET /api/environments, /api/device-runtime/devices — KEEP.
3. Device drawer #device-drawer (deviceDrawer.js) → /api/catalog/*, POST /api/environments/bulk — creation flow DUPLICATES Device-Matrix "Environment builder" tab (same catalog cross-product, same /environments/bulk). Only reachable via device-chip-details now.
4. Device-Matrix admin dialog #device-matrix (deviceMatrixView.js, 5 tabs) → /api/catalog/*, /api/environments(+bulk,PATCH,DELETE), /api/coverage — KEEP.
5. Environments dialog #environments (index.html:600, app.js:6725-6853) → GET /api/environments(+facets,availability) — read-only DUPLICATE of DM Environments tab (same data, subset of features); unique bit = availability explainer.
6. Bulk wizard #bulk-run, run-target #run-target, tc chips — chip lists over picker add-mode, POST /api/sessions — KEEP (different workflows).

Dead UI found:
- #qa-environment-select (index.html:763): captured at app.js:4871 as qaUi.environmentSelect, NEVER referenced again; options never populated; submit path uses matrix envIds only. DEAD.
- #dp-cards (index.html:1359 hidden attr, nothing unhides): devicePicker.renderCards writes loading/error states into an always-hidden container; matrixSidebar renders its own states (matrixSidebar.js:156-170). Visually dead; setFilter/filterDeviceCards legacy path inert (comment says so at devicePicker.js:378).
- el.deviceSelect $('device-select') → null (no such id in HTML); loadDevices null-guards the populate code. deviceState.list still used for run labels.
- Legacy qaConfigMatrix exports createDeselectionStore/computeSelection/computeCappedSelection: imported ONLY by public/qaConfigMatrix.test.js (#14276 retention — expected, not dead). sanitizeSelection IS used by app.js:9,5984.

Results/progress surfaces: all DISTINCT — qaMatrixResultsView #qa-matrix-run-dialog (GET /api/matrix-runs/:id + SSE events + cancel/retry) vs bulkProgress #bulk-progress (client-side batch registry over /sessions) vs run-list vs DM coverage tab (/api/coverage) vs session reports.

No test pins #environments, #device-drawer, #dp-cards or #qa-environment-select (grep of server/*.test.js = 0 hits), so removal is unblocked test-wise.
