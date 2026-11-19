# QASE release notes

## qase-2026-11-20-qa-engine-r1 (UI 20261120-1)

**QA mode rebuilt.** QA runs now use the QA engine in `server/qa/`
([docs/QA-ENGINE.md](docs/QA-ENGINE.md)) instead of the hybrid SDK runtime.

- Every run completes: phases are isolated and time-boxed; model outages,
  phase errors and user stops become report limitations. The run always ends
  `done` with a report (verdict `blocked` only if the site never loaded).
- Much broader detection: overlapping/obscured/clipped content, horizontal
  overflow per viewport, menus opening behind content or off-screen, unfinished,
  slow or janky animations, reduced-motion, dead controls, Escape/focus
  handling, form validation, accessibility, console/network errors, broken
  links, performance, and non-destructive security probes (headers, cookies,
  CORS, exposed files, XSS, open redirect, SQL error indicators, client-side
  secrets, vulnerable libraries).
- Both models are used and both are optional: the reasoning model explores user
  journeys and reviews screenshots/animation filmstrips; JEV verifies and grades
  every candidate. Without keys the automated checks still run.
- Every finding carries a screenshot (where visual), selector, viewports and a
  specific fix; `fix-prompts.md` and the dashboard include it.
- Optional test account at launch for signed-in testing; the password stays in
  the run vault. Writes are blocked during testing unless test writes are allowed.
- Removed: the 24-hour model qualification gate and renewal button,
  `QASE_HYBRID_QA_ENABLED`, `QASE_HYBRID_JEV_NAVIGATION_ENABLED`, the hybrid QA
  runtime and its scripts. SQA/Founder qualified reasoning is unchanged.
- New: seeded-defect QA Lab at `/demo/qa-lab/` (non-production),
  `npm run qualify:qa-live` for capped live-model qualification.
- Storage: no migration. Engine state uses the existing `qa_runs.hybrid_qa`
  column (migration 043). Runs from the previous engine remain readable.
- Docs consolidated into `docs/ARCHITECTURE.md`, `docs/QA-ENGINE.md` and
  `docs/OPERATIONS.md`; dated release reports were removed (see git history).

## Earlier releases

Release notes up to `qase-2026-11-15-evidence-rc2` (SQA batching and coverage,
Founder actions and report reader, test isolation, UI audit fixes) and the
dated qualification reports they reference are in git history:
`git log -p -- RELEASE_NOTES.md docs/`.
