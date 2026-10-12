2026-10-02: User ordered NIHARIKA + PUSHKAR merges removed from DEV, keeping MANOJ's work; no production deploys until user says so.

- Production base commit: 66d7f85 ("Post-revert cleanup ... #14101").
- NIHARIKA merges on old DEV: 3a3dd17, 9b1f403; PUSHKAR merge: 6d3b9d2; tail: 9336f80, f28aac9; then MANOJ merges c670429, 9bd01a0 (via DEV, contained NIHARIKA/PUSHKAR transitively).
- MANOJ's own branch (origin/MANOJ, tip da088ef) does NOT contain the NIHARIKA/PUSHKAR merges — branch point 7e95b62. His work was re-merged cleanly onto 66d7f85: DEV = f04f78d (merge of 66d7f85 + da088ef).
- Conflict in public/app.js qaUi element refs — resolved by keeping BOTH HEAD's security-tests fieldset refs and MANOJ's scopeSelectAll/scopeDeselectAll (index.html auto-merge kept both sections: Supported Coverage panel + Tests/security fieldset).
- Tests: 748 pass / 0 fail / 20 skipped. Preview 200.
- Push was force-with-lease (history rewrite) — teammates must reset their DEV: `git fetch && git checkout DEV && git reset --hard origin/DEV` (their local work should be committed to feature branches first).
- 66d7f85..f04f78d diff = only MANOJ features (SQA feedback phases 1+2, coverage selection panel) + memory/spec notes. No device-matrix/environments/testcase/bugs/Studio files.
- PRODUCTION NOT TOUCHED — still 66d7f85. User explicitly forbade prod deploys until they say so.