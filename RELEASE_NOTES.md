# QASE release notes

## qase-2026-11-20-qa-engine-r2 (UI 20261120-2)

**QA mode talks again, asks for sign-in, and reports fewer false positives.**
Reviewed against a real run on studio.drytis.ai (a login wall: 25 findings, of
which about a third were caused by the test harness itself).

- Conversation layout: the agent narrates every phase in the run conversation,
  posts confirmed findings as cards (severity, page, viewports, screenshot,
  Copy fix prompt) and ends with a report card (verdict, counts, gaps, PDF,
  all fix prompts). The live browser and the evidence tabs sit beside it.
- Sign-in: when the start page is a sign-in wall, or the crawl finds a sign-in
  form, the agent pauses and asks for a test account with a secure card in the
  conversation (or "skip"). The account goes to the run vault; the engine signs
  in once and then crawls the signed-in area read-only. A failed sign-in is
  re-asked once. Waiting time does not count against the run budget; after
  `QASE_QA_CREDENTIAL_WAIT_MINUTES` (default 10) it continues public-only.
  `QASE_QA_ASK_CREDENTIALS=false` turns the question off.
- False positives removed: icon buttons inside fields (show-password) are not
  "covering" the field; contrast is re-measured on rendered pixels (pseudo-
  element and gradient backgrounds); spinners and sign-in-with/off-site
  hand-offs are not graded as animations; explorer findings right after a
  blocked request are flagged as harness side effects; JEV and the reasoner are
  told how the harness works.
- Triage: score = 0.35·detector confidence + 0.65·verifier probability, so a
  verifier that is sure an item is a false positive can now dismiss it (before,
  a 0.85-confidence detector could never be dismissed). Measured severities are
  no longer inflated by one-step verifier grades. The same automated finding on
  several pages is reported once with every page listed.
- Speed and stability: adaptive phase budgets (unused time flows to later
  phases), faster reloads between interaction tests, QA progress no longer
  rewrites the local history file synchronously on every event (it did, which
  stalled large local stores), report refinement has a 150 s cap.
- Fix: engine messages were stored with role "assistant" and showed as
  "System" without formatting.

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
