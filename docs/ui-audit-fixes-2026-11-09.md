# Founder/SQA UI audit follow-up

Base: `Push-SQA` at `1b0d075`. Release: `qase-founder-sqa-2026-11-09-ui-r1`;
UI: `20261109-1`.

This follow-up addresses the UI findings from the current-version audit:

- Results use the SQA assessment verdict and unresolved-control counts instead
  of displaying a blocked assessment as Complete / zero findings.
- Failed SQA controls also show Failed in the report, sidebar and workspace
  status, with a direct action to review their evidence.
- Local and PostgreSQL list summaries retain a lightweight `sqaVerdict`, so
  sidebar presentation agrees with the full report. Durable lifecycle status
  and tenant/owner filtering are preserved. No SQL migration is required.
- The Settings management action opens the existing Device Management module.
  Closing its dialog returns to Settings without discarding the unsaved model
  field.
- Report body text uses 14px, metadata at least 12px, with scoped selectors
  that take precedence over the brand overrides. Responsive wrapping remains
  in place.
- The Founder context notice uses the current theme's readable surface/text
  colors and announces updates. Custom model ID has an explicit accessible
  name and description.
- Successful password reset announces a visible confirmation on sign-in.
  Reset authorization remains single-use and old sessions are still revoked.

The model-free browser regression exercises owned reports, the real API and
store, desktop/390px/320px layouts, both theme contrast values, the Settings
management action and draft preservation. CI runs it on Chromium, Firefox and
WebKit. Account recovery additionally checks the visible confirmation. Focused
unit tests cover full/list SQA presentation and both repository projections.

Generated diagnostics are kept under `test-results/ui-followup/` and the
existing account/recovery directories. Final verification results are recorded
in the local handoff report and linked CI run; a manifest identifies source
bytes and does not by itself establish qualification.

Remaining audit work includes SQA control prioritization/continuation and
evidence collection, qualified Hybrid QA setup, live-network test isolation,
WebKit reload stability, the synthetic-camera fixture, older dashboard
automation and PDF pagination. Real Studio delivery, physical devices and
production activation remain outside this selected export-only UI scope.
