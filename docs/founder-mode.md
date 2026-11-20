# Founder review

Founder mode reviews a product the way a founder, an investor and a
first-time customer would, and tells the owner what to change, what to stop or
avoid, and what to keep so the product looks polished and wins users. It is a
business review, not a bug hunt: every judgement is about whether visitors
understand the product, trust it, start using it and come back.

The engine lives in `server/founder/`. It uses the same architecture as SQA:
host-run stages on the CleanSlate SDK, the **reasoning model only** (no JEV, no
hybrid routing), and a report on every run, even without a model.

## What the owner gives

The launcher asks for the product URL and permission to review it. Everything
else is optional and steers the review:

| Field | Used for |
| --- | --- |
| What should the product achieve? | The goal the advice is measured against (trials, purchases, demos…) |
| Who are your customers? | The person whose eyes the journeys are walked with |
| Stage | Idea, about to launch, early users or growing — changes what "do now" means |
| Journeys to test | Walked first, before the journeys the agent proposes |
| Competitors | Added to the market research and compared against |
| Focus areas | Lenses to weigh in the advice |

If the brief is empty, the agent asks one short question in the conversation
("what should it achieve, and who is it for?"). The owner can answer or reply
*skip*; after `QASE_FOUNDER_BRIEF_WAIT_MINUTES` it continues from the site.
If the site has a sign-in wall, the same secure sign-in card as QA appears;
passwords never pass through the chat, and *public pages only* is always an option.

## Stages

| Stage | What happens |
| --- | --- |
| open | Opens the site and reads up to `QASE_FOUNDER_KEY_PAGES` key pages |
| brief | Uses the launcher brief, or asks one question |
| signin | Asks for a test account only when the site shows a sign-in wall |
| understand | The model records what the product is, the promise, the customer, the business model, the main goal and the journeys to walk |
| market | Web research: direct competitors and what users of this category expect. A competitor is accepted only when its source was found in this run's research |
| measure | The host measures 21 business signals on desktop and phone: headline, first-screen call to action, social proof, company and legal pages, HTTPS, pricing, free start, sign-up friction, visual and readability issues, mobile layout and CTA, speed, errors, broken links, search and sharing metadata, retention hooks |
| journeys | The agent walks each journey in the browser as the target customer and records the outcome, the friction (with its business cost) and what worked |
| evaluate | Each of the 10 lenses is scored 0–10 with cited evidence |
| recommend | 6–15 recommendations — *do* or *avoid*, priority now / next / later, impact, effort, why, how, the metric to watch and when it is done — plus what to keep |
| report | Executive summary, a suggested positioning line and sharper headline options |

Each stage has a deadline from the run budget (`QASE_FOUNDER_MAX_MINUTES`) and
a fallback, so a slow model or a failed search never loses the report.

## The ten lenses

| Lens | Weight |
| --- | --- |
| First impression & value proposition | 14 |
| Onboarding & activation | 13 |
| Conversion & pricing | 13 |
| Product experience & polish | 12 |
| Trust & credibility | 10 |
| Mobile experience | 9 |
| Speed & reliability | 9 |
| Engagement & retention | 7 |
| Competitive positioning | 7 |
| Discoverability (SEO & sharing) | 6 |

**Readiness** (0–100) is the weighted lens score, computed by the host, not the
model. Verdicts: 80+ *Ready to grow*, 60+ *Needs polish*, 40+ *Not ready to
scale*, below that *Major gaps*. A lens the model did not score falls back to
its measured signals.

## Evidence rules

Every judgement cites evidence the host can show: measured signals (`S1…`),
walked journeys (`J1…`) or researched competitors (`C1…`). The recording tools
reject a lens score without evidence, a *do now* recommendation without
evidence, and a competitor whose source was not found in the research. The host
orders recommendations (priority, then impact, then effort) and numbers them
`R1…`. Without a model, recommendations come from the weak and missing signals.

## Results

- **Conversation:** the agent narrates each stage, then posts a readiness card
  and one card per *do now* recommendation.
- **Founder tab:** readiness ring and verdict, summary, positioning and
  headline options, recommendations grouped do now / next / later (with *avoid*
  marked), keep doing, the scorecard with each lens's evidence, the business
  profile, journeys with friction, competitors and expectations, measured
  signals with desktop and phone screenshots, what was not covered, sources.
- **Findings:** *do now* recommendations become `business` findings with fix
  prompts.
- **Exports:** Markdown and PDF.
- **Drytis Studio:** tick recommendations (or *Select do-now*) and *Send to
  Studio* to turn them into build tasks through the signed handoff, or *Copy
  requirements*. Owners, admins and developers can have reviews sent
  automatically when the integration is configured.

Reviews made by the previous Founder pipeline stay listed and their
conversation stays readable; the Founder tab shows a notice for them.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `QASE_FOUNDER_MAX_MINUTES` | 30 (max 120) | Time budget for one review |
| `QASE_FOUNDER_KEY_PAGES` | 8 (max 20) | Pages read before understanding the product |
| `QASE_FOUNDER_ASK_BRIEF` | true | Ask one question when the brief is empty |
| `QASE_FOUNDER_BRIEF_WAIT_MINUTES` | 5 | How long to wait for that answer |
| `QASE_FOUNDER_REASONING` | medium | Reasoning effort (low, medium, high) |
| `QASE_FOUNDER_MAX_TURNS` | 60 | SDK turn ceiling per stage |
| `QASE_FOUNDER_SEARCH_URL` | `QASE_SQA_SEARCH_URL` | Optional SearXNG base URL tried before the built-in search |

The model is the account's reasoning model (`QASE_REASONER_*` / Settings →
Models), the same as QA and SQA.

## Tests

- `server/founder/founder.test.js` — brief, signals, tool validation, scoring,
  ordering and the report.
- `server/founder/founder.integration.test.js` — a full review of the Taskly
  fixture (`/saas/` in the QA Lab) with a scripted model and search stub, and a
  run without a model that asks the brief question.
- `npm run test:founder` (`scripts/test-founder-browser.mjs`) — the whole flow
  in a real browser: launcher, conversation, Founder tab, findings and exports.
