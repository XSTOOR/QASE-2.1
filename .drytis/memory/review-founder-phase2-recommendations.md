# Founder Mode Phase 2 review (#15143) — structured recommendations

Spec: .drytis/specs/founder-mode-recommendations.md. Verdict 4 PASS / 0 FAIL / 3 WARN. Suite: 824 tests, 804 pass, 0 fail, 20 skipped (baseline for this phase).

## Key findings for later phases
- `upgradeLegacyReport`/`upgradeLegacyRecommendation` in server/founderSchema.js (lines ~133-161) are **exported but never called (dead code)**. Legacy finalized reports load via `normalizeFounderState`, which early-returns finalized states untouched — old reports keep original shape; placeholders + `setVersion:0, legacy:true` flag are NOT applied. Consumers (buildFounderReportMarkdown, public/founderView.js) are defensive (`??`, optional chaining, Array.isArray guards) so nothing breaks, but the spec's "normalizer fills placeholders, flags set version" is unwired. Follow-up needed: call upgradeLegacyReport in normalizeFounderState or repository hydration.
- No contradiction post-check — only duplicate detection (category + normalized title, founderSchema.js:258-265). Spec letter said "duplicate/contradictory"; contradiction detection delegated to prompt.
- MIN_RECOMMENDATIONS = 3 (was 6); prompt + tool schema + synthesis all say 3-8, "generate only what evidence supports".
- priority is server-stamped `index + 1` (position = rank); model-supplied priority discarded by design.
- founderEffort maps legacy low→small, high→large.
- Tool schema (founderTools.js reportSchema required array) is slightly stricter than the normalizer — safe direction, no validation-loop stranding.
- assertNoNumericPromise regex: %, x/×, $, million/billion/k, double/triple/quadruple — applied to intendedOutcome only.
- 1 MB assertFounderStateSize guard covers the expanded report shape (oversized test updated and passing).
