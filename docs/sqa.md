# SQA — compliance testing

SQA tests a product against the compliance standards and laws that apply to it.
The agent first works out what kind of product it is testing (a course platform
for children, a store, a health app, a B2B tool…), then researches on the web
which standards fit that product, turns each one into testable requirements,
tests them, and reports the result per standard.

It runs on the CleanSlate SDK with **the reasoning model only**, in a single
agent architecture. JEV and the hybrid router are not used: compliance testing
is reasoning work (reading pages, interpreting laws, judging whether a
requirement is met), and the host measures everything that can be measured.

Code: `server/sqa/`. UI: `public/sqaComplianceView.js` and
`public/sqaCompliance.css`; the conversation cards come from
`public/qaConversation.js`.

## How a run works

The host runs eight stages. In stages 3, 4, 5 and 7 an SDK agent does the
thinking; it sees only the tools of that stage, has a deadline and a tool-call
budget, and the stage counts as done only when its recording tool succeeded.
Between stages the SDK conversation is cleared and the next stage starts from the
saved state, so the context never grows over the whole run.

| Stage | Who | What happens |
|---|---|---|
| 1. Open | host | Loads the product and reads its key pages (home, about, pricing, privacy, terms, accessibility, contact, courses…). |
| 2. Sign in | host | If the product has a sign-in wall, asks for a test account in the conversation (secure card; the password goes to the vault). "Skip" tests public pages only. |
| 3. Identify | agent | `sqa_record_product`: category, sub-type, audience (children, students, businesses), regions, data handled, features, with cited page evidence. |
| 4. Research | agent | `web_search` + `web_fetch`, then `sqa_select_frameworks`: 3–8 standards and laws, each with why it applies and whether it is legally required. A framework is accepted only if its source URL was found in this research. |
| 5. Requirements | agent | `sqa_define_requirements`, once per framework: clause, what must be true, severity, and how it is checked — `automated` (measured evidence), `browser` or `document`. |
| 6. Evidence | host | Measures accessibility, security and privacy signals on the visited pages (list below). Requirements tied to measured evidence are decided here, by the host. |
| 7. Test | agent | Uses the product (`sqa_open`, `sqa_click`, `sqa_type`, `sqa_scroll`, `sqa_press`) and records each remaining requirement with `sqa_record_result`. A pass needs evidence or a checked page; a fail needs what was observed and a concrete fix. |
| 8. Report | host + agent | The host computes scores and the verdict; the agent writes the summary (`sqa_finish`). |

Examples of what the research picks: an education product for children in the US
gets COPPA, FERPA, WCAG 2.2 / ADA; one in India gets the DPDP Act 2023 (with its
children's-data section); a European store gets GDPR, the ePrivacy rules, PCI
DSS for card payments and the European Accessibility Act. These are found on the
web for each run, not taken from a fixed list.

**Every run ends with a report.** Each stage has a fallback: a keyword-based
product profile, a labelled baseline of frameworks and requirements (marked
*Baseline* in the report) when research is unavailable, and host decisions from
the measured evidence. Without a reasoning-model key the run still completes
from the baseline and the measurements, and says so.

### Measured evidence

Accessibility: image alt text, form labels, text contrast, control names, page
language, zoom, touch-target size, headings, page titles, reflow at 320 px.
Security: HTTPS and redirects, HSTS, CSP, framing protection, nosniff, cookie
flags, exposed files, vulnerable client libraries, secrets in client code,
password transport, and safe injection probes (reflected XSS, SQL errors, open
redirects). Privacy: privacy policy, terms, cookie banner and a reject option,
trackers or tracking cookies before consent, contact channel, accessibility
statement, children's notice, privacy notice on data-collecting forms.

All probes are non-destructive and stay on the target's origin. The browser
blocks writes (form submissions, purchases, deletions) throughout.

### Results and scoring

Each requirement ends as **pass**, **fail**, **partial**, **needs documents**
(can only be confirmed with internal evidence, such as consent records or a
DPA), **not applicable**, or **not tested**.

- Per standard: score = (pass + ½ partial) / tested requirements.
- Verdict: **Serious gaps** when a high- or critical-impact requirement of a
  legally required standard fails; **Gaps found** for any other fail or partial;
  **No gaps found** when everything tested passed; **Not assessed** when nothing
  could be tested.

Failed and partial requirements become findings (category `compliance`) with
the requirement, the evidence and the fix, so the Findings tab and the fix
prompts work as in QA. The report is an automated compliance-readiness
assessment, not legal advice or a certification, and says so.

## Using it

Click **SQA** in the side dock (or *Compliance test* in the QA launcher), enter
the product URL, optionally say what the product is and where its users are, and
confirm you may test it. The agent narrates each stage in the conversation, asks
for a test account if it needs one, and ends with a report card. The
**Compliance** tab shows progress, the product profile, the standards with their
sources and scores, every requirement with its result, evidence and fix, the
measured evidence and the research sources. The Report tab, Markdown and PDF
exports carry the same content.

Runs made by the earlier SQA workflow remain listed with their conversation and
findings, and show a short notice in the Compliance tab.

## Configuration

SQA uses the same reasoning model as QA (`QASE_REASONER_*`, or the account's
key). Web research uses the SDK's built-in search; nothing has to be set up.

| Variable | Default | Meaning |
|---|---|---|
| `QASE_SQA_SEARCH_URL` | unset | Your SearXNG base URL, tried before the built-in search providers. |
| `QASE_SQA_MAX_MINUTES` | 30 | Time budget for one run (max 120). Unused time flows to later stages. |
| `QASE_SQA_KEY_PAGES` | 8 | Key pages read before identifying the product (max 20). |
| `QASE_SQA_REASONING` | medium | Reasoning effort passed to the model. |
| `QASE_SQA_MAX_TURNS` | 60 | SDK turn ceiling per stage (10–200). |
| `QASE_QA_ASK_CREDENTIALS` | true | Ask for a test account at a sign-in wall. |

The selected test environment decides the browser engine (Safari → WebKit,
Firefox → Firefox, otherwise Chromium). The launch request fails with an
actionable message if that browser is not installed on the server
(`npx playwright install chromium webkit firefox`).

## API

- `POST /api/sqa/sessions` — `{ authorizationConfirmed: true, focus?, regions?, environmentId?, device?, engine?, deviceLandscape?, testAccount? }`.
  Creates the run; then post the product URL to `/api/sessions/:id/message` to start it.
- `GET /api/sessions/:id` — `sqa` holds the live state (version 3): `phases`,
  `product`, `frameworks`, `requirements`, `evidence`, `sources`, `limitations`.
  `report` holds the scores, verdict and summary.
- `GET /api/sessions/:id/report.md` and `report.pdf` — 409 until the run has a report.
- Events: `sqa.state` (state updates), `finding`, `report`, `message`, `question`.

## Tests

```sh
node --test server/sqa/*.test.js                 # unit tests and the full engine on the QA Lab
node scripts/test-sqa-browser.mjs --browser chromium   # end to end in the real UI
```

The engine test and the browser test use a scripted OpenAI-compatible model and
a local search stub against the QA Lab's BrightPath education site, which has
planted gaps: analytics cookies before consent, no reject option, images without
alt text, a child sign-up form without a privacy notice, and a privacy policy
that never mentions children. No live model or network is used.
