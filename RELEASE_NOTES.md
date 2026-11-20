# QASE release notes

## qase-2026-11-21-founder-business-r5 (UI 20261121-1)

**Founder is now a business review that tells you how to win users.** The old
Founder pipeline is replaced by a new engine (`server/founder/`) built on the
same architecture as SQA: host-run stages on the CleanSlate SDK with the
reasoning model only. The shared agent moved to `server/stageAgent.js`.

- The agent reads the key pages and records what the product is, the promise,
  the customer, the business model and the main goal; researches competitors
  and what users of the category expect (a competitor needs a source found in
  the research); measures 21 business signals on desktop and phone (headline,
  first-screen call to action, social proof, pricing, free start, sign-up
  friction, mobile layout, speed, errors, broken links, sharing metadata,
  retention hooks); walks the key journeys as the target customer; scores ten
  lenses with cited evidence; and writes 6–15 recommendations — do or avoid,
  now / next / later, impact, effort, why, how, the metric to watch and when it
  is done — plus what to keep, a positioning line and headline options.
- Readiness (0–100) and the verdict are computed by the host from the
  weighted lenses. Without a model the review advises from measured signals.
- Steering: the launcher takes goals, customers, stage, journeys to test,
  competitors and focus areas. With no brief the agent asks one short question
  in the conversation (skippable). Sign-in walls use the secure QA card.
- UI: a new launcher, narration and readiness / do-now cards in the
  conversation, and a Founder tab with readiness ring, recommendations grouped
  by priority, keep doing, scorecard, business profile, journeys, competitors,
  signals with screenshots, sources and exports. Recommendations can be
  selected and sent to Drytis Studio through the existing signed handoff.
- Do-now recommendations become business findings; Markdown and PDF exports.
- Removed: the old Founder service, tools, prompts, report drafting, evidence
  and progress routes, the old SDK agent loop and its browser bridge, the JEV
  Founder controller, the qualified "mode reasoning" runtime and their tests
  and scripts. Earlier Founder reviews stay listed and readable.
- Fixed: the Founder launcher no longer loses to the automatic new-test page on
  a fresh account, and Founder runs no longer toast every finding.

## qase-2026-11-20-sqa-compliance-r4 (UI 20261120-5)

**SQA is now compliance testing, and it starts.** The old SQA could not start
without a qualification file and a SearXNG server. It is replaced by a new
engine (`server/sqa/`) on the CleanSlate SDK that uses the reasoning model only
(no JEV, no hybrid routing).

- The agent reads the product's key pages, identifies what kind of product it
  is (category, audience such as children or students, regions, data handled),
  researches on the web which standards and laws apply (for example COPPA,
  FERPA and WCAG for a US education product, the DPDP Act for India, GDPR for
  Europe), breaks each into testable requirements, measures what can be
  measured, tests the rest in the browser and reports per standard.
- A framework is accepted only with a source the agent actually found in its
  research. Scores and the verdict are computed by the host from the results.
- Web research uses the SDK's built-in search; no setup. `QASE_SQA_SEARCH_URL`
  optionally puts your own SearXNG first.
- Every run ends with a report: without a model key or internet, it uses a
  labelled baseline and the measured evidence.
- UI: a simple launcher (URL, optional context and regions, permission), the
  agent's narration and a report card in the conversation, a sign-in card when
  a test account is needed, and a Compliance tab with progress, product
  profile, standards with sources and scores, every requirement with its
  result, evidence and fix, and the research sources. Markdown and PDF exports.
- Failed requirements become compliance findings with fix prompts.
- Removed: the old SQA catalog, qualification gate, JEV verifier, review and
  versions workflow, their routes, scripts and the `sqa-release` CI workflow.
  Runs made by the old SQA remain listed and readable.
- Tests: `server/sqa/*.test.js` (unit and full engine) and
  `npm run test:sqa` (end to end in the real UI), both with a scripted model and
  a local search stub.

## qase-2026-11-20-qa-engine-r3 (UI 20261120-4)

- Plan tab redesigned: an overview (current step, progress bar, viewports,
  browser, sign-in and AI status), coverage tiles (findings open the Findings
  tab), a step timeline with status, outcome and duration, and what was not
  covered. The duplicate browser preview was removed from the tab; the live
  browser above the tabs is the one preview.
- Sign-in: the engine now waits up to 20 s for the site's answer (slow auth
  APIs and client-side redirects used to be read as a rejection), keeps the
  write window open for the whole sign-in, and reports the real reason: the
  site's own error text and the auth request's HTTP status, a CAPTCHA/one-time
  code, or a request that never answered. It asks for another account only
  when the site actually rejected the credentials. Desktop contexts use a
  regular Chrome user agent instead of "HeadlessChrome".
- QA Lab: `/app-login`, a single-page-app sign-in with a slow JSON auth API.
- Dashboard: an open tab reloads itself onto the new UI when the server
  restarts with a newer version (it only did that on page load before).

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
