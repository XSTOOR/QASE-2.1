# JEV interaction accuracy follow-up — 22 October 2026

## What was wrong

The reported Drytis run `08493eea-33d7-4935-9173-9e4d60efe99b` visited 12 routes
in 163 seconds and recorded 615 assertions, but performed only four disclosure
checks and no tab or fragment-link trials. Much of the count was DOM semantics,
not interaction coverage. Lazy content remained hidden until scrolling. The UI
also mapped every completed plan item to “Passed,” including untested security
checks. More time or a forced minimum finding count would not fix these causes.

## Implemented changes

- Reveal lazy content with bounded, overlapping document scrolling before
  discovering controls. Restore scroll and retain any unvisited distance.
- Exercise observed tabs, mobile menus, in-page fragment links and up to 24
  disclosures per route. Verify real panel visibility rather than accepting
  an `aria-expanded` change as sufficient evidence.
- Preserve per-control failures and continue other candidates. Restore the
  source document after custom hash views; editing the URL alone is insufficient.
- Use deterministic scroll positioning with ordinary browser actionability
  checks, never force-clicking covered or hidden controls.
- Keep policy enforcement, bounded locator timeouts, reproduction evidence and
  guarded local interactions. Authentication/network-dependent workflows are
  not converted into false defects or passing checks.
- Prefer new functional route families in the fallback planner and remove
  redundant inspections. JEV Decisions remains the sole model provider.
- Distinguish Completed/Tested/Partial/Not tested/Not observed in the Plan UI.
  Preserve interaction limitations and full totals when report detail is capped.

## Live verification

Monitored run `eccf3c30-f655-4fb7-8bc8-6bc125f87522` on `https://drytis.com/`:

| Measurement | Result |
| --- | --- |
| Routes | 12 |
| Duration | 313 seconds |
| Assertions | 685 |
| Disclosure checks | 20, up from 4 in the reported run |
| Document exploration | 12 scroll scenarios |
| Other new interactions | Product-tab and fragment-link trials; mobile menus |
| Standalone inspect calls | 34, down from 59 |
| JEV calls / tokens | 11 / 11,466 |
| Confirmed target defects | 0 |

This run exposed two executor gaps rather than site defects: a Pricing FAQ
timeout caused by competing scroll animations, and a Blog link timeout after
an article view replaced the source DOM. Both were fixed afterward and verified
with targeted live checks. The Pricing FAQ then clicked and exposed its panel;
the Blog check restored its source and continued without the timeout. Custom
article behavior remains outside the native-fragment correctness oracle and is
explicitly marked as a scope gap, not a pass. A transient connection refusal
during the Blog recheck cleared on the subsequent connectivity/browser check.

The final recovery changes received targeted verification, not another complete
12-route live run. No complete-site, business-logic or security pass is claimed.

## Acceptance and regression evidence

The expanded loopback fixture deliberately includes uncaught exceptions, failed
required scripts/images, overflow, unnamed controls, stale search results,
unresponsive disclosures, broken mobile menus, missing fragment targets,
broken tab panels and false-expanded panels. The first expanded end-to-end
run `448264c2-4a02-4284-bb5d-896ffa3e2bf9` confirmed 13 findings. Normal anonymous
authentication and speculative prefetch responses were not filed as defects.
The final deployed-server fixture run
`cce440b6-9c2f-435c-a1fe-0faadcadf858` also confirmed 13 findings across 58
assertions in 22 seconds, with zero unavailable checks and zero unresolved
candidates. Its mobile-menu finding uses the corrected failure wording.

Full-suite verification: 1,859 passed, 26 skipped, no failures or cancellations
in the successful reruns. An earlier mouse-scroll timeout passed its isolated
rerun. Final recovery/report/interaction regression checks are also run against
working and broken fixtures, including custom hash-view restoration and blocked
POST attempts.
The final targeted suite passed all 23 tests. QASE and the JEV lab both returned
HTTP 200 from their health endpoints; the temporary fixture server was stopped.

Verification runs use a separate local account; they do not rewrite the user's
historical reports. Refresh QASE and start a new run under your own account to
use the updated controller. Old plan labels are corrected at render time.

## Remaining scope

This improves evidence-driven browser coverage; it does not fine-tune JEV model
weights or create a generative endpoint. Full authenticated workflows, external
applications, business-rule correctness, submitted forms, security scenarios
and subjective visual/content requirements need explicit authorized fixtures
and expected outcomes. A zero-finding public sample is not a release approval.
