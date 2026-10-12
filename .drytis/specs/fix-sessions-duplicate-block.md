# Fix duplicated block & undefined `engine` reference in POST /api/sessions

## Problem
Merge residue in the POST /api/sessions handler (server/app.js ~1707–1746): two try
contexts with stray top-level statements between them (track(...), a `const cohort`,
and `const session = await services.runs.create(engine === 'chromium' …)` at ~1743)
referencing an out-of-scope `engine` variable → `ReferenceError: engine is not defined`
thrown repeatedly at runtime. The request still succeeds via the first try-block, so
behavior is preserved by keeping the first path and deleting the residue.

## Files to change
- `server/app.js` — remove the dead/duplicated block only; no behavioral change.
- Regression test (extend `server/app.test.js` or a focused new test): POST
  /api/sessions creates a session cleanly (201, expected fields) and the dead path
  cannot execute / no ReferenceError surfaces.

## Acceptance criteria
- [ ] No duplicated try-block or stray top-level statements; no undefined `engine` reference
- [ ] Regression test added and passing
- [ ] POST /api/sessions still 201s with expected fields
- [ ] app.test.js, securityRegression.test.js, matrixApi.test.js, npm run test:auth all pass

## Out of scope
SMTP setup (pending customer credentials); live password-reset email delivery verification.
