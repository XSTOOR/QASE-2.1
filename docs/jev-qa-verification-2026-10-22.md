# JEV QA executor verification — 22 October 2026

Target: https://thewariend.com/

Final monitored run: `76dd5059-5771-4928-8961-b001ee491f03`, created under
the isolated local verification account, not the user's signed-in account.
Model returned by the gateway: `typesafe/jev-1.13-20260917`. No other model used.

## Result

The live run completed in approximately 64 seconds with 12 distinct rendered
routes, 112 scenario/tool records (including discovery/readiness inspections),
201 individual assertions, zero failed assertions, and zero confirmed findings.
It stopped at the configured representative-route budget, not a model-selected
early finish. This is **partial coverage, not a full-site or release pass**.

| Executed area | Assertions | What the evidence establishes |
| --- | ---: | --- |
| Responsive geometry | 72 | Overflow/control reachability at 390, 768 and original widths |
| Image/media loading | 77 | Bounded visible image decoding and media loading state |
| Navigation | 37 | Actual anchor clicks, back/forward restoration and safe disclosure responses |
| Broken links | 11 | Rendered destinations after real link clicks |
| Native form constraints | 3 | Detached required/invalid/corrected field validation, not app submission |
| Search control | 1 | Enabled/editable control, not query results or relevance |

Console/network diagnostics were captured on all 12 rendered routes. Every
recorded route retained the selected 1440×900 viewport after layout testing.
The report includes 43 expandable evidence groups with expected/actual results
and scenario limitations, also available in the JSON export.

## Gaps retained honestly

- Two observed disclosure controls at `/agents` timed out during real clicks.
  Those operations remain unavailable coverage, not passing assertions.
- Twenty additional observed safe routes remained outside the sample budget.
- Login/logout and credential-negative workflows need an authorized test account.
- Application form submission, error recovery and persisted state were not tested.
- Search-query submission/results and media playback/seek remain unverified.

## Defects fixed while monitoring

1. Removed QA's six-action sampling loop and early-finish decision option.
2. Replaced the generic four-item plan with per-selected-check dispositions.
3. Replaced direct-URL navigation claims with click/back/forward assertions.
4. Added multi-width layout, image loading and native constraint scenarios.
5. Fixed a live-preview screenshot race that could restore the wrong viewport.
6. Changed blank-page recovery to retry once and continue the remaining frontier.
7. Reacquire controls after layout changes; inspect the exact visible image
   sample that was actually decoded, rather than a different later DOM sample.
8. Preserve assertion failures/unavailable checks separately from confirmed
   findings; neither can silently become a full pass.

## Regression evidence

Full suite: 1,841 passed, zero failed, 26 skipped. Additional final browser-policy
and recovery tests: 12 passed. Controlled real-browser fixtures verified deliberate
overflow, broken image, disabled search, double-confirmed 404, history restoration,
viewport restoration and no record-creating form submissions.

Both local services returned HTTP 200 after completion: QASE on port 5174 and
the JEV lab on port 5175. Refresh QASE and start a new run to use the new executor;
historical runs are not retroactively presented as having executed new checks.
