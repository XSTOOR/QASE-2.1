# QASE-2.1 environment postmortems (2026-10-09)

## ENOSPC filled the volume → all auth writes 500
`.qase` grew to ~800MB: leftover `*.tmp*` atomic-write files from interrupted writes
(~250MB) + 399MB of run artifacts (120 dirs, all older than current day) + 109MB
matrix-runs.json. Every POST /api/auth/login|register returned **500** with
"Unexpected server error" — the local auth store persists via
`writeFile(tmp) + rename` and ENOSPC fails there. Nothing in logs named ENOSPC
(logger only prints errorName). Diagnosis: run a register/login probe against the
real `.qase/auth.json` with createLocalAuthService in a script — the raw error
surfaces. Cleanup: delete `.qase/*.tmp*`, purge artifacts dirs older than today
(they're per-run evidence; user's runs were all completed/old). Check `df -h
/workspace` FIRST when API writes 500.

## PID exhaustion (EAGAIN on any spawn)
PID 1 accumulated ~7,600 zombie children from earlier sessions; pids.current hit
the limit → `node --test` fails with `spawn EAGAIN` and even `ps`/`pkill` hang.
Only fix: `restart_container`. Full `npm test` (1,000+ tests, process isolation)
also re-triggers resource pressure; run suites individually instead.

## Known failing suite (pre-existing, environmental)
`server/defectFixtures.test.js` — 3 tests fail because Playwright WebKit can't
launch (`libgstreamer-1.0.so.0` missing on the fresh container until the setup
script finishes installing browser deps). NOT a code regression.

## Password policy (ticket #15672)
`PASSWORD_MIN_LENGTH` in server/auth.js:10 is the single source of truth; frontend
has 3 literal spots (index.html ×3, app.js renderAuthMode). Lowered 12 → 8.
