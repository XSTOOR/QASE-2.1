# Founder Mode

Founder Mode is Qase's evidence-informed product, design, growth, and
go-to-market review workflow. It uses the same constrained CleanSlate browser
runtime as QA and SQA, but persists a separate `founder` run type and produces a
structured founder brief instead of a defect report or compliance verdict.

## What it reviews

The built-in review taxonomy currently contains 17 lenses:

1. Customer discovery and ICP
2. Product clarity
3. User experience
4. UI and visual design
5. Onboarding
6. Activation
7. Retention
8. Monetization and pricing
9. Positioning
10. Differentiation
11. Go-to-market and sales
12. Marketing and growth
13. Trust, privacy, and security
14. Accessibility
15. Technical and product quality
16. Metrics and experiments
17. Roadmap and prioritization

These lenses organize the review; they are not pass/fail controls. Founder Mode
records strengths, friction, opportunities, and risks, each with a low, medium,
or high confidence level and references to completed browser activities.

## Start contract

The launcher collects:

- an authorized HTTP or HTTPS target;
- product/project name and optional release/environment;
- business stage and business model;
- target-customer/ICP hypothesis;
- the primary outcome the review should optimize;
- team, runway, regulatory, technical, or launch constraints; and
- optional named competitors or alternative approaches.

Only the target name, URL, and authorization confirmation are required to create
the session. Missing strategic context becomes a blocking agent question or an
explicit, lower-confidence assumption; it is never silently invented.

`POST /api/founder/sessions` creates an idle session. The client then submits the
target URL through the existing `POST /api/sessions/:id/message` endpoint, which
binds the target to the run and starts the existing agent execution path. When
the creation payload already contains a URL, the start URL must be canonically
identical; Qase rejects attempts to switch the review to a different target
after authorization. The binding is retained in the durable event stream.

Example creation payload:

```json
{
  "authorizationConfirmed": true,
  "target": {
    "name": "Acme workspace",
    "url": "https://product.example.com",
    "release": "2026.08",
    "environment": "staging"
  },
  "productContext": {
    "stage": "early growth",
    "businessModel": "B2B SaaS",
    "targetCustomer": "Operations leaders at 50–500 person companies",
    "primaryGoal": "Improve trial activation",
    "constraints": "Four-person product team; no pricing migration this quarter",
    "competitors": ["Current spreadsheets", "Named alternative"]
  }
}
```

The instance-scoped catalog endpoint is `GET /api/founder/catalog`. It returns the
schema version, categories, observation types, confidence levels, and the fixed
advisory boundary used by the interface.

## Agent workflow

Before publication, the agent must:

1. create and complete a visible review plan;
2. inventory public and authorized product surfaces;
3. exercise a representative, reversible end-to-end workflow;
4. inspect desktop and narrow viewport behavior;
5. collect a browser snapshot and diagnostics;
6. ask for credentials when authentication blocks material in-scope surfaces,
   unless the user explicitly narrows the review to public/anonymous surfaces;
7. obtain or explicitly infer the minimum founder context;
8. record at least one evidence-backed observation for every review lens; and
9. finish every plan item before publishing the founder brief.

The runtime exposes two Founder-specific tools:

- `record_founder_observation` stores one browser-evidence-bound observation.
- `finish_founder_review` validates and publishes the structured final report.

Both run behind the existing tool allowlist. Founder Mode has no filesystem,
shell, source-control, analytics, email, CRM, billing, arbitrary network, web
search, or competitor-research tools.

## Founder brief

The final report contains:

- an executive summary;
- an ICP hypothesis with users, buyers, jobs, and pains;
- category, one-line positioning, value proposition, differentiators, and
  alternative approaches;
- a dedicated monetization/pricing proposal with value metric, packaging,
  presentation, and validation tests;
- prioritized recommendations with impact, effort, confidence, actions,
  evidence references, and assumptions;
- marketing channels, content angles, launch motions, and possible growth loops;
- sales motion, qualification questions, objection handling, and enablement
  assets;
- risks and mitigations;
- quick wins referencing recommendation IDs;
- a 30/60/90-day plan; and
- north-star candidates plus bounded, measurable experiments and guardrails.

The server normalizes this payload outside the model, rejects unknown evidence
references, requires each strategic claim to cite observations or name its
assumptions, computes evidence confidence, applies strict field/array limits,
redacts vaulted secrets, and rejects a Founder state whose UTF-8 JSON
serialization is 1,000,000 bytes or larger. PostgreSQL adds a slightly larger
1 MiB physical JSONB ceiling as defense in depth because its binary JSON size
is not identical to the application serialization size.

`GET /api/sessions/:id/report.md` returns `409` until the review is finalized;
after publication it returns the complete Founder-specific Markdown report,
including evidence confidence, the observation/evidence registry, provenance
references, assumptions, and every validated commercial and product section.
The finalized Founder pane exposes both Download and Copy actions for it.

## Evidence and safety boundaries

Browser evidence proves only what was visible or happened during this run. It
does not prove customer demand, conversion, retention, revenue, CAC, LTV, market
size, competitor capabilities, or experiment outcomes. Suggestions involving
those facts must remain hypotheses with validation steps.

Founder Mode never claims that it reviewed the complete codebase or repository.
It describes its scope as the **browser-accessible surfaces reviewed**. It stays
on the authorized origin, does not browse unrelated competitor sites, and does
not delete data, publish content, contact prospects, change pricing, invite
users, send messages, start trials, purchase, or enter payment data.

The fixed report caveat states that the result is product and go-to-market
guidance—not legal, financial, investment, security, or regulatory advice—and
that no recommendation guarantees revenue, growth, funding, or product-market
fit.

## Persistence and events

Local mode round-trips the Founder state in `.qase/sessions.json`. PostgreSQL
mode stores it in the bounded `qa_runs.founder_assessment` JSONB column added by
migration `009_founder_review.sql`. QA, SQA, and Founder payloads are mutually
exclusive at both the repository and database-constraint layers.

Durable Founder events are:

- `founder.created`
- `founder.target_bound`
- `founder.observation`
- `founder.finalized`

Creation is attributed to the trusted per-instance actor; agent observations
and publication retain the existing trusted request/agent attribution rules.
Organization and project identity always come from trusted instance and tenant
context, never from the request body.
