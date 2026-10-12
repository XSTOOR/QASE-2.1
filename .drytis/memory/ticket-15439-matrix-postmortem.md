# #15439 — QA run device×browser matrix bugfix (postmortem)

## Root causes
1. **Only two devices displayed**: /api/qa-configurations paginated raw catalog rows (200/window) in envId insertion order → first window was all Samsung Galaxy A15/A25. Fix: `buildQaConfigurationsByDevice` in server/qaConfigurations.js + `groupBy=device` param; frontend 12-devices-per-window + "Load more devices". Verified: 176 unique devices in first window, all 5 platforms present.
2. **Multiple selections collapsed to 1×1**: DISPROVEN — no such defect existed. 3×3 POST produced 9 items, 9 distinct real browser sessions, sequential execution. configurationEnvIds pinned 1:1 in matrixService.create().
3. **Incorrect UNAVAILABLE / BLOCKED**: userAgentFor() stamped Chrome/CriOS UA on every non-Safari browser and used the OS major in brand tokens → runtimeIdentity flagged "browser mismatch"/"version mismatch". Fix: brand-correct UAs per platform×browser (FxiOS/EdgiOS/OPiOS/DuckDuckGo/Brave tokens), brand tokens carry BROWSER major (browserMajor), macOS Safari Version token = browser major. 24 platform×browser identity combos verified OK.

## Residual (out of ticket scope)
Matrix items still end BLOCKED because the QA agent PAUSES awaiting_input (security/target authorization question, agent.js:1007) on unattended runs; orchestrator honestly maps awaiting_input → BLOCKED. Not a dispatch/identity failure — sessions are real, fixtures execute, artifacts captured. A separate decision is needed for auto-answering or pre-authorizing targets in matrix mode.

## Ops notes
- CSRF for API scripting: cookie qase_csrf (jar) → X-CSRF-Token header; /api/auth/csrf route does NOT exist (404).
- Device-grouped window: `?status=available&groupBy=device&pageSize=200` returns first rows of every platform.
- Suites: deviceRuntimeProfiles 17/17, runtimeIdentity 15/15 pass.
