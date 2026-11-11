# SQA and Founder completion efficiency — 11 November 2026

## Changes

The preceding live SQA qualification rejected the final plan item `Call
finish_sqa_assessment to publish deterministic verdict`. The publication matcher
recognized natural-language task names but not that literal tool invocation.
The model then repaired the plan and tried publication again. Readiness and
publication now share `isPublicationTodo`, which recognizes that standalone
publication instruction. Pending tasks and technical tasks mentioning a finalizer
remain unfinished; the evidence and assessment validators are unchanged.

Founder now submits a complete, intact saved draft to its existing finalizer
without asking the model to request publication. The host supplies only the
exact saved draft revision. It does not generate sections, alter recommendations,
add evidence, or lower any publication requirement. The last draft tool result
is persisted before the SDK can request another provider response. Successful
publication stops only the model stream and completes the run. Restoring a
complete draft can also publish without contacting the model. A validation or
storage failure leaves the draft intact and pauses with its reason.

The Founder recovery qualifier now selects isolated storage before importing
application modules and requires a fresh output directory. It cannot overwrite
previous qualification evidence or delete a snapshot from the user's runtime.

## Regression coverage

- 129 focused tests passed, including exact SQA task wording, complete draft
  restoration, duplicate SDK result delivery, cancellation, tampering, evidence
  prerequisites, unsupported source-audit claims and failed storage.
- 111 related service, schema, report, evidence and mode tests passed.
- 27 additional native SDK, three-engine smoke and investigation tests passed.

Logs are under `test-results/completion-efficiency-20261111`:
`focused-replay-fixed.log`, `related.log`, and `sdk-regression.log`.

The first live recovery attempt exposed a duplicate-event bug in the candidate:
the executor persisted a draft result, then the streamed copy created another
activity with the same ID and a running status. That could block publication.
The fixed handler recognizes the saved result, and a regression test now
reproduces both deliveries. The failed recovery and interrupted fresh run remain
in `founder-resume` and `founder-live`; they are not counted as successful checks.

## Live saved-report recovery

The corrected qualification in `founder-resume-fixed/result.json` passed using
the existing `custom` / `z-ai/glm-5.2` gateway. Starting from the same prior
checkpoint with four completed sections and two saved recommendations, it
finished all eleven sections and three recommendations in 2 minutes 27 seconds.
It retained every saved section, the recommendation prefix, observations and
usage; no browser work was replayed. Checkpoint reload, Markdown/PDF exports and
the configured-credential scan passed. The original source checkpoint remained
byte-for-byte unchanged.

The finalizer activity is host-owned, and the resulting session has no duplicate
activity IDs. Three model calls generated the remaining draft groups; there was
no subsequent model call just to publish. Additional estimated input usage was
32,891 tokens, compared with 43,341 in the earlier successful recovery trial from
the same checkpoint. This is one observed comparison with generated content and
provider latency variation, not a general performance guarantee.

## Fresh-run qualification

`founder-live-fixed/result.json` **failed the unchanged twelve-minute deadline**.
The controlled two-route review retained all 17 observations and seven complete
report sections, including all three recommendations. It stopped with 314,848
input / 31,540 output / 346,388 total estimated tokens. The 750,000 input-token
qualification ceiling was not reached. This was a duration failure, not a
gateway connection failure or a confirmed defect in the target fixture.

The run spent its early turns collecting browser evidence and saved its 17
category observations together after 25 activities. That trace identifies a
remaining opportunity: bounded investigation steps and earlier observation
checkpoints, followed by another fresh qualification at the same deadline.
Faster publication alone does not establish faster end-to-end investigation.
The stopped checkpoint is retained, and any subsequent report recovery is
recorded separately; it does not turn this failed deadline check into a pass.

The follow-up `founder-fresh-resume/result.json` passed: an isolated copy of that
seven-section checkpoint completed the remaining four sections in 71 seconds,
using 21,074 additional estimated input tokens. All prior sections, observations
and usage were retained, with no browser replay or duplicate activity IDs. The
host published the exact completed draft; checkpoint restoration, Markdown/PDF
exports and the credential scan passed. The combined retained usage was 335,922
input / 33,661 output / 369,583 total estimated tokens. The original stopped
checkpoint was unchanged.

## Scope

Budgets, report schemas, evidence requirements, original saved user runs and the
gateway environment are unchanged. These changes remove avoidable publication
work; they do not establish complete authenticated application coverage or
guarantee a completion time across providers and targets. This candidate has not
been pushed or deployed.
