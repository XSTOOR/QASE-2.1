# QASE-2.1 matrix pipeline recon (read-only, for pipeline-fix planning)

Selection: NO selectedDeviceIds/selectedBrowserIds arrays — pure derived model. Full catalog index minus persisted deselection store (localStorage `qase.qaConfigDeselections`, public/qaConfigMatrix.js:47-95) capped at MAX_RUN_CONFIGURATIONS=2000 (qaConfigMatrix.js:437; server twin MAX_MATRIX_CONFIGURATIONS=2000 at server/app.js:973). Explicit ticks while capped pinned via unscopedExplicitSelection (session Set, app.js:4926) honored by computeCappedSelection (qaConfigMatrix.js:130-151). NO global "Select All configurations" button exists (store.clear() never called from UI); qa-select-all buttons target test checkboxes / scope checkboxes only. Per-family select-all = the family checkbox (app.js:5183-5213).

Device scope: qaMatrixSetDeviceScope (app.js:5132-5144); clicking a device ROW scopes the run (app.js:5263-5282); scoped selection uses deviceScopeSessionDeselections (session Set) not the persisted store; scope key change resets both sets. NO way to un-scope back to full catalog from the UI (qaMatrixSetDeviceScope(null) never called from a handler).

Submit: POST /api/qa-matrix-runs (public/app.js:5905-5915; route server/app.js:953-1025) payload {targetUrl, configurationEnvIds, kickoffText, selectedTests, securityAuthorization, scopeSelection}. matrixService.create (matrixService.js:302-456) — launcher mode pins one item per envId (lines 356-389); the OTHER path (expandMatrixItems, lines 92-158) does profile×browser expansion with targets[0] newest-version pick (line 142) — that's the only single-item .find/[0] logic, not in the launcher submit path.

Orchestrator: worker pool over QUEUED items (matrixOrchestrator.js:206-229), parallelism = QASE_MATRIX_PARALLEL (default 1, clamp 1-4, lines 434-438). MAX_MATRIX_CONCURRENT=2 declared at line 28 but NEVER ENFORCED. Item timeout QASE_MATRIX_ITEM_TIMEOUT_S default 1200s (425-429). Poll loop 2s (line 420). awaiting_input → BLOCKED (289-297) — NO pre-authorize/auto-answer mechanism for matrix child sessions (child inherits selectedTests/securityAuthorization/scopeSelection via startSession hook app.js:853-871; founder-only auto-answer exists at app.js:1969-1971). Browser cleanup: orchestrator has NONE; relies on agent idle timer (agent.js:1144-1153, QASE_BROWSER_IDLE_MS default 0 = never auto-close) + closeOtherBrowsers at turn start (agent.js:628, 355-368).

No batching/parent-run for >2000: hard 422 cap at route (app.js:974-980) + 8mb body limit (app.js:259).

Results board: public/qaMatrixResultsView.js polls GET /api/matrix-runs/:id every 2500ms (lines 32, 152-164); SSE exists only for sessions (app.js:4543); matrix SSE events are emitted server-side (app.js:927-943) but NO frontend consumer (grep matrix_run_/matrix_item in public = 0 hits).

DuckDuckGo NOT_SUPPORTED: browserSupportResolution.js:67-69 + short-circuit 130-137 (never probed); localBrowserRegistry.js:88-91 DUCKDUCKGO_LOCAL_RESOLUTION.
