# Merge origin/DEV into PUSHKAR — #14282 working notes

Goal: bring Mishal's QA test-selection + security-authorization features,
Manoj's Studio UI alignment (#13918–#13925), and the Postgres insertAggregate fix
into our PUSHKAR branch (which holds Studio R1–R6, UX U1–U5, phases 3–12).

## Incoming commits (origin/PUSHKAR..origin/DEV), 9 commits
- affd691 (Mishal) QA default test selection + security catalog/selection/authorization
- 0a97f6f (Manoj) Align UI with Drytis AI Studio theme (#13918-#13925)
- reconciliation merges f01e01c / e034c73 / bca7244
- ae382b2 insertAggregate placeholder off-by-one fix; ef8e925 COALESCE revert

## Known clash points
- DEV migrations 021_qa_test_selection.sql + 022_security_authorization.sql collide
  with our 021_environments / 022_device_catalog → renumber DEV's to 025/026
  (our dir is clean 001–024).
- DEV removed the `.cli-theme` prefix layer and un-prefixed test selectors;
  our R1–R6 redesign deliberately KEPT `.cli-theme` and seam-pinned selectors.
  Resolution: keep our token/selector system, adopt DEV's fonts (local woff2) and
  any genuinely additive styles.

## Status (2026-10-02)
- Merge in progress on local PUSHKAR; 8 conflicted files, 98 blocks:
  styles.css (81), app.js (3), runRepository.js (4), migrations.test.js (6),
  server/app.js, app.test.js, founderUi.test.js, runRepository.test.js (1 each).
- Continuation instructions: /workspace/.drytis/next-steps.txt
