# Complete browser/device selection and execution — proposed acceptance contract

Status: proposal awaiting customer agreement. This document is a specification, not a work tracker. Existing board tickets remain authoritative.

## Customer outcome
The customer can select the intended device/browser configurations, start testing, and account for every selected configuration in the results without silently losing selections or receiving misleading availability claims.

## Evidence and constraints
- Current code limits unscoped default selection to 2,000; client and API also reject larger individual runs. The earlier `qarun-full-matrix-execution.md` explicitly preserves this cap. Changing this requires agreement to the proposal below.
- Existing uncommitted catalog and identity changes must be preserved and reviewed, not discarded or assumed correct.
- The previous turn freshly ran 49 selection/profile/identity tests successfully. It did not verify the browser journey. Historical checked criteria in the earlier spec are not fresh acceptance evidence.
- Matrix orchestration treats `awaiting_input` as terminal BLOCKED. Diagnose which questions are required and preserve customer authorization boundaries.
- User-agent overrides are not independent evidence of actual installed browser identity or physical hardware.
- Board listing currently returns only the first 100 Done tickets, ending #14275. Pagination arguments are unsupported. Known related tickets #14276 and #15439 cannot be fully inspected using the currently exposed listing. Obtain full board descriptions before creating or replacing tickets; do not overwrite their acceptance contracts.

## Proposed scope
1. Complete, stable selection: list every catalog device/browser with its status; distinguish Select all matching from page selection. Preserve explicit selections through search, pagination, dialog reopening and reload. Deduplicate configuration IDs without collapsing distinct OS/browser/orientation variants. Show exact selected and executable counts.
2. Accurate availability: resolve actual runner health and provider configuration; report per-configuration reasons for unsupported, temporarily unavailable or unconfigured targets. Refresh after recovery. Identify emulation, engine-equivalent execution and real devices explicitly; verify actual engine/binary independently of overridden UA.
3. Execute the complete selection: replace selection truncation with a durable parent execution containing bounded batches (retain existing per-batch safety limit where appropriate). Freeze a unique configuration snapshot at submission. Show total, queued, running, completed and blocked counts. Start runnable configurations even when other selections have explicit blockers. Never silently drop a selected configuration.
4. Reliable lifecycle: idempotent submission/retry, bounded concurrency, persistent progress, restart recovery, cancellation and explicit retry of failed work. Preserve completed outcomes during recovery; interrupted work is not passed or silently rerun. Required user input remains visible and can resume the affected work without invented answers or authorization.
5. Related cleanup and verification: fix reproducible duplicate controls/sections and duplicate scheduling in the selection-to-results journey. Smoke-test adjacent existing QA entry points and reports. Record unrelated findings for scoped follow-up rather than claiming the entire product defect-free.

## Acceptance scenarios for the eventual ticket review briefs
- Selection: using a catalog larger than 2,000, select all matching, deselect one configuration, change filters/pages, close/reopen and reload. Exact IDs/counts persist; no substitution by catalog order; distinct variants remain distinct.
- Boundary execution: test 0, 1, 2,000, 2,001 and full-catalog unique selections. Empty selection has actionable validation. Nonempty executable selections queue completely with no lost IDs or duplicate logical work. Duplicate IDs in a request do not duplicate execution.
- Mixed availability: combine healthy local, unavailable, unsupported and unconfigured-provider targets. Reasons are accurate per item; runnable work starts; blocked work is separately accounted for. Recovery updates availability without fabricating a result.
- Identity: test supported installed engines/brands and intentionally mismatched or emulated configurations. Evidence distinguishes requested configuration from actual runtime; spoofed UA alone cannot satisfy real-device or exact-version claims.
- Recovery: interrupt submission, reload UI, restart worker and retry a request. Parent identity, counts and completed results persist; queued work resumes safely; uncertain in-flight outcomes are explicit. Cancellation prevents remaining queued work from starting.
- Input: exercise an agent request for required input. User sees the question against its configuration, supplies an answer and resumes; no silent terminalization or automatically fabricated approval.
- Permissions: a second account cannot view, cancel, resume or retry another account's execution through UI or API.
- End-to-end: on the actual preview at `/`, use the existing QA launcher against a verified safe local demo fixture. Select multiple devices across available platforms/engines, start, observe queue and inspect configuration-specific results/evidence. Reconcile all selected IDs with recorded outcomes and reload persistence.
- Scale: test full-catalog selection/batch accounting with deterministic execution fixtures; run a representative real-browser subset. Report these separately. A simulated scale test is not evidence that tens of thousands of real browser sessions ran.
- UI regression: inspect related launcher/device/results surfaces at desktop and narrow widths for duplicate controls, conflicting counts, hidden errors and clipping; verify keyboard selection and actionable launch errors.

## Assumptions and open decisions
- Recommended approach: transparently queued batches under one execution, rather than launching the whole catalog simultaneously.
- Existing local emulation remains usable and clearly labeled. Exact physical-device/browser coverage requires suitable configured providers; credentials and paid provider setup are not invented or bundled into this repair.
- Verify existing demo fixture routes and available test accounts before writing guided board scenarios; do not put credentials in briefs.
- No production deployment or Git publication is included without authorization.

## Board handoff after agreement
Resolve incomplete board access; update existing matching tickets while preserving their descriptions/briefs, or create nonduplicate tickets with structured review_brief objects. Cover every requirement with stable scenario IDs, attach the cross-feature journey to the final integration ticket, and retain recommendations: [] unless optional improvements are actually identified. Implementation status changes belong to coding mode.
