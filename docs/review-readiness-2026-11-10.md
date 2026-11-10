# Founder/SQA review readiness candidate — 10 November 2026

Candidate: `qase-founder-sqa-2026-11-10-review-readiness-r1`, UI `20261110-3`.
Based on Push-SQA `1f1a304`; existing hybrid integration and assurance evidence guards are preserved.

## Resulting behavior

- SQA's basic setup needs a URL and testing authorization. Product name, release/build identifier and target deployment environment are optional under Advanced options. The test time is recorded automatically. Missing metadata remains missing rather than being replaced with a year, “current” or “local”. Existing supplied metadata remains unchanged.
- Founder and SQA launchers retain an existing manual device selection. With no selection, they can choose a desktop environment that is explicitly AVAILABLE, preferring Chrome/Chromium. Unknown/unavailable runtime rows are not guessed as available; the device picker remains usable. The chosen profile is visible and editable before launch. Asynchronous catalog retrieval does not block the modal opening.
- Execution badges recognize the canonical store's lowercase execution types. Launcher copy clarifies that simulated profiles do not certify a physical device or native operating system.
- `browser_read_page` reads rendered text in bounded ranges with explicit offsets, total length, truncation/continuation metadata and limitations. It neither executes model-supplied scripts nor submits forms. This makes below-the-fold pricing text accessible without treating an interactive-element snapshot as complete page coverage. Existing runtime permissions and SQA tool/token budgets still apply.
- Founder exploration and synthesis instructions distinguish scoped non-observation from proven absence. They require inspection of relevant pricing sections, discourage claims that inaccessible internal features do not exist, and keep post-signup prompt restoration unverified without an authorized completed journey. These instructions improve evidence handling; they are not a guarantee that a model cannot make a factual mistake.
- When no eligible bounded email workflow exists, SQA can sample native constraints of empty text/search/URL/textarea fields on detached copies. Prefilled and password fields are excluded. No original input handler or submission is exercised. These are partial samples, not proof of application validation/error recovery. Existing host guards continue to reject a complete form-validation pass without its matching live workflow evidence.
- Configured-provider SQA uses the SDK's native tool schemas without duplicating their full JSON schema in the system-context description. No safety, time or token ceiling was increased. Overall efficiency improvements must be measured rather than assumed.

## Qualification evidence

Retained locally under `test-results/review-readiness-20261110/` and `test-results/sqa-release/1794333275825/`:

- 145 focused regression checks passed, including bounded page reading, metadata normalization, scope/authorization guards, evidence binding, text-form safety and mode tool boundaries.
- The SQA acceptance gate passed 221 contracts and startup/launch/evidence journeys across Chromium, Firefox and WebKit. Historical exports, restart persistence and manual device restoration remained covered.
- Fresh-user browser checks passed in all three engines: supported default selection, unknown target metadata preserved through the actual creation API, ready Founder launcher, mobile width, and intercepted model dispatch. Availability in this UI fixture was explicitly synthetic; this is not hardware attestation.
- The new reader and detached form fallback passed against the public Drytis site in all three engines. The reader found all six published model rates, including below-the-fold content. Both homepage text forms were sampled without original input changes or submission. Initial attempts timed out while the broad browser suite was running; the later retry passed. A timeout was not recorded as a target defect.
- The first broad regression runner omitted relative-path static assets. Those affected UI/provider contracts passed after supplying the assets. A mismatched Docker release argument was corrected. A transient external HTTPS check passed independently. The corrected full-suite rerun passed **2,421 tests, zero failures, 33 environment-dependent skips**, retained as `full-regression-final.log`. After final reader hardening to exclude select/editor values, 81 focused reader/runtime checks also passed; the new hardening is covered by that later focused run.

## Remaining release gates

The live Founder controlled-fixture run did **not** finish within its 12-minute qualification deadline. It retained all 17 evidence-backed areas and four of eleven report sections, with 379,567 estimated total tokens. The configured token ceiling was unchanged and was not the cause of this stop. The checkpoint is retained; recovery qualification is separate from successful autonomous completion within that deadline.

The live SQA run executed all six technical controls successfully and retained seven passing controls overall, plus three evidence blockers. It then ended with the configured model connection error at 314,358 estimated input tokens; no final assessment was published. This is a failed end-to-end qualification, not six failed browser checks. Do not classify that connection error as a target defect or claim the release is fully qualified.

Founder recovery then completed all eleven sections and published the report, without replaying browser work, using 43,341 additional estimated input tokens. All 17 observations, completed sections and the saved partial recommendation prefix were preserved; Markdown/PDF exports passed. The existing recovery qualifier initially rejected appending a third recommendation to an unfinished list. Its preservation check was corrected to compare the saved prefix while still requiring complete saved sections to remain exactly equal. The already completed real recovery was revalidated offline; the original failed harness result remains retained beside `post-run-validation.json`. This establishes recovery, not autonomous completion within the original twelve-minute gate.

Final artifact pointers are recorded in the local handoff. Do not replace an incomplete model result with a claimed pass. The user-authorized conditional push is held while live SQA qualification remains incomplete; these changes do not establish production readiness.

Production has not been deployed by these changes. The previously inspected deployment advertised `coverage-r3` / UI `20261110-1`. Operators must verify the actual frontend/backend source and release identity after any authorized deployment. Source promotion does not authorize production migrations, new credentials, physical-device claims or Studio delivery.

Additional work remains for full authorized authenticated application journeys, broader application-specific form recovery, complete accessibility assessment, immutable per-run build provenance in exports, and evidence supplied by reviewers. Missing assurance records remain legitimate prerequisites; disabling the budget will not supply them.

No existing saved user run or gateway configuration was changed by the isolated qualification. Pre-existing `output/` is outside this candidate.
