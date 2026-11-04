# SQA release acceptance

Run the same SQA checks locally and in CI:

```sh
npm ci
npm run audit:dependencies
npx playwright install --with-deps chromium firefox webkit
npm run test:sqa-release
```

Use the supported Node.js version (22 or 24). On Linux, Playwright system
dependencies and the runtime's WebKit display prerequisites must be available.
The check fails when a selected engine cannot launch; it never substitutes a
different browser or reports a missing engine as a passing skip.

## What the gate checks

- SQA catalog, scope, evaluator, recovery budgets, tools, human review, immutable
  history, evidence integrity, UI contracts and run/API access boundaries.
- The actual SQA browser bridge in Chromium, Firefox and WebKit: required-input
  rejection, successful form submission, observed engine identity and retained
  evidence verification. These are controlled local fixture checks.
- Each browser's authenticated startup at desktop and 390-pixel mobile widths:
  immediate SQA entry, a delayed startup response, catalog failure/retry, cancel,
  and return from ordinary QA. An injected old startup implementation must fail
  its interaction check, establishing a negative control.
- Each browser's desktop/mobile evidence and reviewer journey: verified, missing,
  mismatched and external evidence; literal script-text safety; review inbox,
  draft, control evidence, publication, preserved publication text during a
  duplicate update, version comparison, historical Markdown/PDF and persistence
  after restarting its isolated server.

The evidence journey uses an instance-owner fixture. First-party sign-in is
tested separately by startup acceptance; account/run access boundaries are also
covered by API contracts. This does not claim a full production identity-provider
or multi-tenant end-to-end deployment test.

The three browser engines are Playwright builds. Mobile checks cover responsive
layout at a narrow viewport; the WebKit runtime fixture additionally uses iPad
emulation. These results do not establish physical iPhone/iPad/Safari or device
farm coverage.

## Isolation and results

The gate allocates its own loopback ports and test directories under
`test-results/sqa-release/<timestamp>/`. It does not need a running development
server or an environment file. Child processes receive OS/browser-discovery
settings without inheriting gateway keys, database credentials or application
configuration. Browser requests that would start a model message are blocked and
counted; acceptance requires zero such requests.

All contracts run with a separate working directory so local test state is kept
out of the user's `.qase` directory. Browser tests create synthetic local users
and assessments and stop their temporary servers when finished. The user's
development server is left running.

The top-level `result.json` records the tested source fingerprint, Git base,
Node/OS identity, per-stage status, contract totals, browser versions and child
results. The fingerprint covers server, public, scripts, workflows and package
files, including uncommitted edits. A source change during acceptance fails the
gate. Each stage keeps its own log, browser screenshots and result; evidence
acceptance also retains the historical PDF.

Contracts require zero skips or failures. Missing or incomplete browser results,
the wrong browser identity, JavaScript errors, unintended model requests, broken
history or mobile overflow fail the gate. Results from a previous output folder
cannot satisfy a new invocation.

Run a single scenario while diagnosing a failure:

```sh
npm run test:sqa-startup -- --isolated --browser firefox
npm run test:sqa-evidence -- --browser webkit
```

The startup command also retains its existing optional positional loopback URL
for checks against a development server; that mode creates local test accounts
in that server. Prefer `--isolated` for repeatable acceptance.

## Dependency security gate

`npm run audit:dependencies` checks the installed runtime dependency tree against
the npm advisory database and fails for moderate or higher findings. Both the
SQA workflow and the main verification workflow run this after `npm ci`. A
passing functional suite does not bypass the audit. The check needs registry
access; an unavailable registry is a failed check rather than an accepted waiver.

The reviewed security lockfile retains CleanSlate 0.1.0 and Playwright 1.62.0,
updates vulnerable packages within their existing major versions and raises the
Nodemailer minimum to the tested 10.3.1 release. Use `npm ci` so the reviewed
lockfile is reproduced. Security updates require their own audit, full
verification and SQA acceptance; avoid unreviewed `--force` upgrades. The focused
dependency tests exercise cross-family proxy trust and compressed-body process
survival in disposable local fixtures. They do not attack a deployed server.

## CI and release checklist

`.github/workflows/sqa-release.yml` runs the same gate on Ubuntu and Windows with
Node 22 on pushes, pull requests and manual dispatch. It uploads selected reports,
logs, screenshots and PDFs even on failure. Private `.qase` state is not part of
the artifact selection. This workflow supplements the existing full repository
verification and production-image workflow; it does not replace them.

Before deploying SQA changes, verify:

- SQA acceptance passes against the final stable source on each CI operating
  system. A local run is evidence for that machine only.
- Full repository verification and production-image checks pass without excluding
  failing files. Known local Windows exclusions in earlier phase reports are not
  release waivers.
- The release identity, source manifest and package describe the actual reviewed
  source. Run the existing release preparation/verification process after the
  final code is reviewed; a stale manifest must not be represented as verified.
- The intended provider/model succeeds in a bounded live assessment with the
  deployed authentication, network policy and storage configuration. This
  key-free gate tests deterministic behavior and browser integration, not model
  quality, provider uptime or billing limits.
- Reviewer roles and run access are provisioned in the intended deployment.
- Production restart/recovery, persistence/backup and actual device coverage meet
  the release's declared scope.

These checks prepare an SQA release for review. They do not publish source, create
a commit, push a branch or deploy the application.

## Live model qualification and candidate preparation

For a bounded, authenticated run using an existing gateway, pass only the local
environment file's path:

```sh
npm run qualify:sqa-release -- --env-file /path/to/gateway.env
```

This opt-in command makes real model requests. It creates a controlled loopback
site and a separate authenticated Qase server with local test users. It checks
all six technical web controls, all four bounded smoke actions, complete
assessment coverage, retained evidence integrity, version-specific Markdown/PDF,
cross-account denial and persistence after a full restart. Missing reviewer
documents must leave the broad assessment blocked. It stops at its configured
deadline or input-token acceptance ceiling and scans artifacts for the configured
credential values. The default deadline is 12 minutes; use
`--timeout-minutes 1..15` when needed. Results are stored in
`test-results/sqa-live-release/<timestamp>/`.

Prepare a review snapshot with:

```sh
npm run prepare:sqa-release
```

The command creates a new directory under `test-results/sqa-candidates/`, copies
the existing release inventory, normalizes only the copied text to LF, and aligns
the snapshot's release identity, Docker label default and current UI version. It
adds an SQA handoff note and generates/verifies the snapshot's manifest. The
working tree and its historical production identity are preserved. It refuses an
existing destination or a destination inside inventoried source directories.
Use `--release-id <identifier>` to name a reviewed security candidate separately
from an earlier candidate with the same UI version.

Run full `npm run verify`, `npm run test:sqa-release` and `npm run release:verify`
inside that snapshot. Then run its existing package command with a new absolute
ZIP output path. Qualify the packaged source/image before promotion. The snapshot
includes uncommitted work, so identify it by its manifest and ZIP checksum rather
than claiming its Git base commit alone identifies those bytes. Preparing or
packaging a snapshot does not authorize deployment.
