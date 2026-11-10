# SQA evidence work queue

The earlier bounded live run recorded seven passing controls and closed 23 at
the budget boundary. Eleven of those still need browser evidence (five also
need reviewer artifacts); the other twelve need reviewer-only documents.
These counts describe that saved run, not a new claim of product coverage.

SQA now derives a read-only work queue from the authorized scope and recorded
control dispositions. The six WEB controls remain first. Later browser work
uses windows of four objectives ordered by mandatory status and severity,
including mixed controls that require both browser and reviewer evidence.
Every remaining browser control stays in the planning index; a detail window
cannot reduce scope. Completed dispositions do not demand another workflow.

The configured-provider path exposes `read_sqa_work_plan`; the qualified path
also supports the same pages through `mode_execution_progress`. Use
`sqa_view=browser` for objectives/contracts, `sqa_view=reviewer` for artifact
requests, or `sqa_view=media` for the complete meeting/media operating guide.
Browser and reviewer pages contain at most four entries, with `next_offset`
and the returned revision for subsequent reads. A disposition or requirement
change invalidates that revision: restart at offset zero to avoid skipping
newly pending work. Read only what the next workflow needs; do not prefetch
the complete catalog before testing. Media restrictions remain summarized in the operating
brief; full instructions are requested before exercising those workflows.

After technical controls have dispositions, the legacy operating brief stops
repeating the completed smoke procedure. Both paths retain permissions,
evidence ownership, exact requirement types, workflow readiness and finalizer
gates. Reading guidance does not write state or reopen a finalized/budget-closed
assessment. The existing human evidence-review workflow remains responsible
for accepting supplied artifacts and publishing a new assessment revision.

The Markdown evidence-request register distinguishes browser checks from
reviewer documents. Each row identifies the control, requirement ID, type,
minimum count and description from the evaluated requirement snapshot.
Browser samples cannot satisfy approval records, risk registers, independent
tests or other reviewer-only contracts. The evaluator and assessment hashes
are unchanged.

On the fixed core-scope context fixture, the qualified operating brief changed
from 13,878 to 9,167 characters; the configured-provider brief changed from
15,039 to 12,980 characters before technical work in the combined release.
The combined release retains matching host receipts for navigation/form
verdicts, isolated form HTTP requests and the explicit device-picker return
to quality review. These are character counts,
not token or end-to-end coverage guarantees. Live-provider verification and
final release checks are recorded in the local handoff and exact-commit CI.

Execution budgets, origin restrictions, browser evidence validation, model
profile selection and certification limitations retain their existing
contracts. No supplied artifact is assumed to exist merely because it appears
in the request register.
