# Founder/SQA export-only release qualification

Release: `qase-founder-sqa-2026-11-08-release-r1`; UI: `20261108-2`.
The user selected export-only Studio handoff for this release. No Studio
destination/signing key was supplied or enabled. No production activation,
production database migration or real Studio delivery is authorized by source
promotion alone.

## Candidate provenance

The integration includes `Push-SQA` at `6f4a4d8c5a29642ec00a368e5014ddfcf38f09de`
and `codex/hybrid-production-readiness` at
`21aeb0b1968e8a15a86290578c93ff67ca7486e2`. Phase 7 is commit `694b32c`.
Remote history must be fetched again before promotion. Promotion is a
fast-forward of the verified descendant; unrelated or newer work must not be
discarded. Existing account/run data and generated output are preserved.

## Database correction and upgrade

Migration 040's constraint allowed only version 1 Founder project state. Phase
7 emits version 2 action metadata. Mock repository contracts and local files
did not establish compatibility with that database constraint.

Migration **044** accepts version 2 without rewriting legacy rows or changing
the original migration checksum. It also enables and forces tenant row-level
security with matching `USING` and `WITH CHECK` policies. PostgreSQL deployments
must apply 044 through their normal reviewed DDL/backup procedure before
accepting these writes. Local-store deployments do not run SQL migrations.

The real PostgreSQL integration fixture first applies migrations through 043,
persists legacy Founder state, then applies only 044 and compares the saved
row. Separate repository pools race edits and deliveries under a non-superuser,
non-BYPASSRLS role. Required results include one winning edit, no duplicate
delivery, preservation of another report's selection and default-deny reads.
Disposable schemas and databases are used; production services are not targets.

## Required release evidence

| Gate | Evidence |
| --- | --- |
| Local regression baseline | Phase 7: 2,398 passed, zero failed, 33 optional environment skips; action and reader browser journeys passed. |
| Migration/repository contracts | Current ordered migration set, unchanged old checksums and bounded atomic action behavior pass. |
| Live configured-provider SQA | Original controlled fixture, all 30 applicable controls assessed, all six technical controls passing, verified evidence, exports, restart and account isolation. Missing reviewer documents remain honest blockers. |
| Live configured-provider Founder | Four-route fixture, all 17 lenses and 11 sections, unchanged time/token ceilings, mid-report restart, saved-content/usage retention, exports and account isolation. |
| Linux Node 22 regression | Full suite with isolated PostgreSQL and Redis endpoints; default-deny non-bypass database role. No actual model credentials are present in CI. |
| Browser acceptance | Founder completion/recovery/reader/actions, both launchers and SQA startup/launch/evidence on Chromium, Firefox and WebKit. |
| Image | Build the root Dockerfile at the exact candidate SHA, then smoke the same image with non-root/read-only hardening, required authentication, closed registration and all three browser engines. No model calls. |
| Promotion | Match the green CI commit, immutable image identity, source manifest and remote branch ancestry. Preserve private data and do not force-push. |

The live gateway environment file remains local and must never be copied to
GitHub Actions secrets, artifacts, images or source as part of this release.
Configured values are checked against retained local qualification artifacts.
The live runs are serial to avoid adding gateway contention to their existing
deadlines. Provider/model and agent safety limits are unchanged.

CI provisions only disposable PostgreSQL/Redis services. PostgreSQL tests use a
role without superuser/BYPASSRLS privileges. A separate disposable Redis process
tests restart/reconnection. The public CI passwords are fixture values, not
deployment credentials.

## Evidence records and scope

Live results and credentials scans are retained locally under
`test-results/integration/phase8-*`. GitHub Actions links and immutable commit
identity are the remote evidence. Final promotion results are recorded in the
delivery report and pull request so documentation does not change an already
verified image's commit identity.

This release does not activate qualified Opus/JEV execution or reconcile the
older unresolved JEV usage receipt. Real Studio delivery, production topology,
distributed failover and native realtime/media certification remain separate
operator gates. Optional fixtures outside configured-provider Founder/SQA are
not implied to be production-qualified. Browser engine availability does not
establish native Safari or physical-device execution.
