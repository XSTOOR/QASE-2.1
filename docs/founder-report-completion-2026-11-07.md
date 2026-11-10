# Founder report completion — Phase 4

Branch: `integration/founder-sqa-20261107`, based on setup commit `dd81cae`.
Release: `qase-founder-sqa-2026-11-07-report-r1`, UI `20261107-3`.

## Change and compatibility

New configured-provider Founder runs select a persisted, versioned report
protocol before SDK execution. Completed browser work transitions into eleven
typed report sections, with recommendations saved one at a time. Sections keep
every required report field while bounding text and lists. The full existing
report normalizer and readiness gate remain authoritative at publication.

Only the next typed section is advertised. The finalizer becomes available
after every section is saved, and accepts the exact complete draft revision.
Evidence references, assumptions, recommendation IDs and unsupported numerical
promises are validated. Stale/tampered drafts cannot publish. Duplicate deliveries
are idempotent, including the third recommendation after the next section has
advanced. Corrections require the current revision. Writes serialize, and failed
storage restores the prior checkpoint before another write can proceed.

Advertised evidence and quick-win references enumerate the exact saved IDs.
Unknown evidence returns the rejected IDs and valid choices for a bounded retry;
the host never guesses which evidence a mistyped reference meant. This also
preserves the existing validator as the final authority when a provider ignores
an advertised enum or JSON field type.

Between saved sections, the supported SDK conversation boundary clears redundant
model history. Browser ownership, plan, observations, usage, permissions and
saved sections stay intact. Synthesis context carries the next section, saved
recommendation IDs and access/context decisions. A restart can rebuild synthesis
from durable state without replaying browser investigation.

New Founder runs retain the native SDK tool schemas. The fallback description
also points to those schemas instead of repeating them. This description change
alone did not reduce recorded input estimates during live investigation; the
measured report-history reduction comes from the section continuation boundary.

Previously executed legacy runs retain their full-report protocol. The qualified
Opus/JEV strategy retains its existing staged report path and accounting. The
bounded JEV runtime keeps its own report controller. A saved configured-provider
run cannot switch to qualified reasoning via a flag change or silently resume
under the bounded JEV controller. Unsupported saved protocol versions fail
explicitly. No schema migration, new inference loop or dependency change is
required; new state is stored in the existing Founder JSON aggregate.

## Verification

The final 130 focused report, SDK, prompt, qualified-mode and recovery checks pass.
A subsequent 120-test protocol/SDK/recovery check also passes, including
text-only legacy runs with prior model usage. These counts overlap. The
dashboard completion acceptance passes all eleven cases with no page errors.
Full verification passes: 2,366 tests, 2,333 passed, zero failed or cancelled,
33 optional skips, plus syntax/private-path/credential checks. The final protocol
and evidence-reference changes were additionally covered by the focused run
and 109 affected native SDK, Founder, prompt and persistence checks, all passing.
These test counts overlap. The later recovery harness has a separate syntax
check and is exercised directly against the live gateway.

The first full-suite attempt ran in the restricted sandbox, which blocked the
HTTP/browser fixtures; it was stopped and repeated with local networking enabled.
Those sandbox failures are not a passing regression result.

Two four-route live attempts stopped at the qualification harness's 750,000
input-token estimate ceiling during investigation, before any report section
was written. They retained 15 and zero observations respectively, with 807,924
and 801,441 total input estimates after in-flight cleanup. They are failed
qualification attempts. The gateway did not return canonical usage receipts;
these figures are SDK estimates, not verified billing. Prompt-description
cleanup did not improve that result. This leaves investigation efficiency as
an open issue; it does not prove the report generator failed or succeeded.

The compact live investigation completed all seventeen lenses with nineteen
observations and saved the executive summary, then stopped at the same ceiling
with 765,352 cumulative input estimates. It is not a passing full-run
qualification. Its intact, public-only checkpoint supplies the real browser
evidence for a separate, bounded report-recovery qualification. That test reads
an isolated copy, preserves original usage and saved sections, permits at most
250,000 additional input estimates over ten minutes, and cannot replay browser
work. It does not modify the source checkpoint or certify the investigation's
efficiency.

The first recovery attempt saved ICP, positioning, monetization and all three
recommendations but reached its ten-minute deadline after an unknown-evidence
refusal in marketing. The saved draft remained intact. Exact-ID enums and
actionable retry data were then added. A fresh isolated runtime resumed that
five-section checkpoint and successfully published all eleven sections with
three recommendations. It used 102,744 additional input estimates in about four
minutes, retained all five saved sections and nineteen observations, and
performed no browser replay. A mistyped sales evidence reference and an omitted
metrics field were rejected and corrected through normal SDK tool retries.

The final lifetime input estimate was 986,036; it includes the earlier
investigation and both recovery attempts. The two recovery attempts together
added 220,684 input estimates to the compact investigation. Usage was not reset.
The restored checkpoint/report matched durable state, Markdown and PDF exports
passed (98,027 and 351,446 bytes), the source checkpoint stayed unchanged, and
the artifact scan found no configured credentials. This is live report/recovery
qualification using real saved browser evidence, not a passing autonomous
investigation or a production gateway/account-isolation certification.

Local evidence:

- `test-results/integration/phase4-full-verification-r2.log`
- `test-results/integration/phase4-evidence-references.log`
- `test-results/integration/phase4-final-integration.log`
- `test-results/integration/phase4-completion-browser.log`
- `test-results/integration/phase4-live-r2/result.json` (failed investigation)
- `test-results/integration/phase4-live-r3/result.json` (failed investigation)
- `test-results/integration/phase4-live-compact/result.json` (ceiling after first section)
- `test-results/integration/phase4-report-resume/result.json` (deadline; draft retained)
- `test-results/integration/phase4-report-resume-r2/result.json` (passed recovery)

The live harness uses the existing environment-file path without copying its
contents into source or reports. It starts an isolated account/server and a
four-route local target with a reversible browser-only form. `--compact-fixture`
selects a smaller two-route investigation while retaining all seventeen lenses
and every required report field. The optional
`--restart-during-report` check stops at a saved section, restarts the server,
and continues the same report. It asserts saved content and evidence are
preserved, no browser work is replayed, exports work, usage persists and a
different account cannot read the run or exports. It scans retained artifacts
for configured credentials.

```powershell
node scripts/qualify-founder-release.mjs --env-file 'PATH-TO-EXISTING-ENV' --restart-during-report
node scripts/qualify-founder-report-resume.mjs --env-file 'PATH-TO-EXISTING-ENV' --checkpoint 'CONTROLLED-FIXTURE-CHECKPOINT' --output-dir 'ISOLATED-OUTPUT'
```

Production activation, remote pushes, CI/container qualification, authenticated
external apps, qualified gateway receipts and distributed recovery remain in
the release matrix. Phase 5 covers clearer progress and recovery controls;
Phase 8 handles release promotion to Push-SQA. The Phase 4 local report milestone
is complete. End-to-end investigation efficiency and broader release
qualification remain open and must not be inferred from this recovery result.
