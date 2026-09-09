# Qase mode revalidation and production-readiness report

Report date: 10 September 2026. Execution evidence: 8–10 September 2026.

## Decision

The project has been hardened and validated locally across QA, SQA, Founder,
and the signed Drytis black-box, white-box, and combined workflows. Agents can
now exercise native synthetic microphone capture and observed meeting links.
The mode-validation baseline passed **429 tests, with zero failures and two
database integration skips**. The authentication follow-up adds the account
and memory coverage described below. This is a staging-release candidate;
production deployment and infrastructure qualification remain outstanding.

The work changed source and tests in this checkout. It did not deploy a service,
modify the user's saved test history, or test an actual customer meeting.
The post-auth regression suite runs **433 tests with 427 passes, zero failures,
and six explicit browser/database skips**; the six skips are environment-gated
integration cases that require the separately provisioned Playwright or
PostgreSQL runtime.

## What was fixed

| Area | Change and practical effect |
| --- | --- |
| Microphone capability | Added `browser_media` permission grant/deny/reset, bounded native capture probe, signal detection, and application track inspection. All browser profiles launch with synthetic devices. Full Chromium is used because Windows headless shell rejected native capture. Probe-only voice processing is disabled to avoid suppressing the synthetic tone; application capture retains its own constraints. |
| Permission persistence | Corrected the CDP microphone permission descriptor and retained its controller for the context lifetime; detaching it immediately silently removed overrides. |
| Meeting links | Added visible-anchor validation, scoped prejoin navigation, source/destination tab IDs, expired-link inspection guidance, and popup adoption. Supported external entry routes do not grant unrestricted third-party browsing. |
| Evidence quality | Exposed native form validity flags without typed values. Instructions distinguish native rejection from missing DOM error copy, and muted audio from a paused recorder. Growing encoded silence is not proof of microphone leakage. |
| Mode boundaries | Tool descriptions, execution registry, and authorization use the same per-mode allowlist. Shell/filesystem tools and other modes' finalizers are excluded. |
| Final reports | QA rejects malformed findings, invalid verdicts, unfinished plans, and unsupported completion. Removed the model's force-completion bypass. QA/SQA/Founder roll back finalization state if persistence fails. |
| Agent lifecycle | Successful finalization ends the model stream. Stop works during graceful iterator exit, automatic continuation, and timeout backoff. Explicit idempotent finalization succeeds; a stale report alone cannot mark a new run complete. |
| Founder synthesis | The host rejects renamed/reordered canonical plan items. Once evidence and workflow gates are satisfied, a dedicated synthesis phase retains durable observations and replaces redundant browser transcripts with a concise finalizer-only context. This resolved the observed report-generation timeout in recovery. |
| Dashboard events | Launch waits for the actual SSE subscription. Early disconnects release late subscriptions; reconnection reloads missed session state without overwriting newer arriving events. |
| Shutdown/readiness | API, worker, heartbeat, and control-plane processes have bounded cleanup; readiness reflects drain state. Cleanup continues when another stage fails, and a second shutdown signal can force exit. |
| Dependencies and CI | Patched fast-uri, qs, and hono; declared Playwright directly. Added CI for install, audit, tests, browser, and dashboard checks, with a restricted PostgreSQL test role. |
| First-party identity and memory | Added scrypt password hashing, opaque server sessions, CSRF protection, account/profile/memory APIs, local atomic persistence, PostgreSQL migration 011 with RLS, and owner-filtered run reads. |

## Authentication productionization

The dashboard now starts behind an account gate whenever the configured services expose the auth adapter. Registration creates an account and owner membership in the configured tenant; login rotates the prior session. Run aggregates carry the authenticated owner UUID, so one account cannot list, open, mutate, or delete another account's runs through the API. Profile and memory endpoints are scoped to the authenticated user, and memory is bounded and filtered for credential-shaped content before it can reach an agent prompt.

The local adapter writes only password hashes, session digests, and bounded profile/memory data to `.qase/auth.json` through a temporary file and rename. The PostgreSQL adapter uses `users`, `organization_memberships`, `qase_auth_sessions`, and the new `qase_user_profiles`/`qase_memory_entries` tables. Apply migration `011_first_party_auth_profiles.sql` before enabling production traffic. Keep `QASE_AUTH_REQUIRED` at its default (`true`) in production; set it to `false` only for a deliberately trusted Drytis compatibility host.

The browser sends the CSRF value from the non-HttpOnly cookie in `X-CSRF-Token` for every write. Cookies are `HttpOnly`/`SameSite=Lax`, use `Secure` in production, and sessions are revoked on logout or replaced on the next login. The auth service is independent from browser execution, so QA, SQA, and Founder policy gates remain unchanged.

## Validation matrix

| Layer/mode | Evidence | Result |
| --- | --- | --- |
| Local full verification | 164 JavaScript syntax checks, private-path ignore checks, credential-signature scan, 431 test cases including real browser cases | 429 pass, 0 fail, 2 database skips |
| QA real configured model | Full controlled fixture run; 96 activities, 8 media calls, 2 meeting calls; approximately 8m 46s | Completed and exported; early findings exposed inference problems addressed below |
| QA final focused model regression | 49 activities; native capture, mute/unmute/stop, invalid email, prejoin, expired link; 5m 52s | Completed, `pass_with_issues`; real stale-meter defect plus an informational expected-410 observation |
| SQA real configured model | Core + web/UI scope, 30 controls; 105 activities, 8 media calls, 2 meeting calls; approximately 11m 26s | Completed: 10 pass, 2 fail, 18 blocked, 0 unassessed; six technical controls: 4 pass, 1 fail, 1 blocked |
| SQA fresh rerun | 128 activities; repeated keyboard loop-guard pauses and microphone work exhausted its 15-minute qualification budget before meeting checks | Did not complete; retained as a model-reliability failure, not included in pass counts |
| SQA recovery on updated guidance | Restored the same local fixture, reused completed evidence, tested both remaining meeting links, and recorded remaining controls; 18 additional activities, 6m 52s | Completed: 13 pass, 0 fail, 17 blocked, 0 unassessed. All 6 technical controls passed; overall verdict correctly remains blocked. |
| SQA deterministic mode matrix | Each of the five profiles and their combined scope, all ten product attributes, real tools/evaluator/report with simulated activity evidence | Passed; reviewer-only prerequisites remain blocked |
| Founder real configured model | Original run collected 22 observations across all 17 areas, 10 media calls and 2 meeting calls; hit a 15-minute report timeout | Original run failed to publish; retained as failure evidence |
| Founder recovery on fixed synthesis | Restored the canonical plan from completed saved browser evidence, then used the new synthesis phase; 2 additional activities, 4m 5s | Complete report published with all 17 areas and explicit assumptions; recovery is not a fresh full browser rerun |
| Founder fresh end-to-end rerun | 60 activities, 25 observations across all 17 areas, 8 media calls, 2 meeting calls; 10m 21s | Completed and published without manual recovery. Host rejected a renamed plan and malformed report payload; the model corrected both before publication. |
| Drytis integration modes | Signed black-box-only, white-box-only, and combined requests; scope, static manifest, evidence and result contracts | Deterministic/API tests passed; no live Drytis deployment tested |
| Dashboard | Three launchers, scope/authorization, mobile landscape, 768/390px dialogs, disconnect recovery, production demo disabled/readiness | 10 checks passed, no page errors |
| Report delivery | Completed QA, SQA and Founder artifacts through real HTTP Markdown and PDF routes | All returned usable Markdown and PDF responses |
| Dependency audit | Production dependency audit after lockfile patches | 0 reported vulnerabilities at audit time |
| Authentication regression | Live local API: anonymous 401, registration/login cookie issuance, CSRF 403/201, profile persistence, and two-account run/memory isolation | Passed |

The configured-model runs used `z-ai/glm-5.2` through the existing custom gateway,
on Node 24.19.0. The target was the generated local **Team practice studio** fixture.
Model timings describe these runs, not a latency guarantee. Passing a workflow
test means the agent completed and recorded results; it does not mean the target
application passed every check.

## Microphone and meeting evidence

Four real Chromium integration cases verified:

1. Native denied permission produces `NotAllowedError`; grant enables a live audio
   track and detectable synthetic signal; the probe releases tracks. App start,
   mute (`enabled=false`), stop (`readyState=ended`), and permission reset work.
2. Only an observed visible meeting anchor can be opened; prejoin and expired
   pages are inspected, source tabs are retained, popups become the active tab,
   and an unapproved join action is blocked.
3. iPhone viewport/user-agent emulation survives browser suspension/restoration;
   restored contexts retain synthetic capability and start with prompt permission.
4. Native invalid-email flags are observable without exposing the entered value.

The final QA model report correctly records that muted MediaRecorder bytes may
grow while the input meter is silent. It also observes `typeMismatch`,
`valid=false`, and no POST for the invalid email. The earlier QA report had
misinterpreted both behaviors; that original artifact is retained, not counted
as proof of those defects. The final run still detects the fixture's stale meter
after Stop, demonstrating that the correction did not suppress real findings.

A later full-suite run exposed intermittent low signal from the synthetic probe
with voice-processing defaults. After disabling those filters only for the probe,
three consecutive native-capture regressions and the complete 429-pass suite
succeeded without reducing the signal threshold. The failed run is preserved in
`test-results/verification-microphone-signal-failure.log`; the repeated checks are
in `test-results/raw-microphone-regression.log`.

SQA exercised granted/denied permission and recovery in its original complete run.
Its original fail verdict should not be treated as independent proof of invalid
submission: that report preceded the shared form-validity correction. A fresh
run on the corrected workflow exhausted its 15-minute budget after repeated
keyboard/microphone work and did not reach meeting checks. The deterministic
SQA contracts and shared browser regression suite passed; the failed fresh run
remains important evidence that unattended model completion is not guaranteed.
Recovery with the updated guidance completed the remaining work and published
all 30 controls. Its two low-severity fixture findings describe stale success
feedback after native form rejection and an untitled expired-meeting page;
neither claims invalid submission or a failed meeting merely from HTTP 410.

Meeting coverage is **prejoin only**. Provider URL policy is tested for supported
Google Meet, Zoom, Teams, and Webex patterns; live provider lobbies were not
qualified. No physical microphone, remote peer, live conference audio transport,
speech recognition accuracy, or actual participant interaction was verified.

## Release requirements still outstanding

| Requirement | Why it remains open |
| --- | --- |
| PostgreSQL/control database integration | No suitable local databases were available; two integration tests skipped. Run the new CI workflow and require both suites to execute successfully with a restricted role. |
| Production topology | No deployment destination, Kubernetes cluster, or Docker/PostgreSQL environment was available. Run the repository's staging smoke, resilience, load/capacity, and release-gate procedures against the intended topology. |
| Operational evidence | Actual TLS/ingress, Redis coordination, backup restoration, rolling drain/restart, tenant isolation in the deployed database, and capacity under load need staging results. Mock/contract tests cannot establish these properties in deployment. |
| Actual target qualification | Supply the intended application and dedicated test meeting/account. Exercise provider-specific redirects/login/lobbies and permitted meeting scenarios; label hardware and real audio transport coverage separately. |
| Model reliability | Founder now completed a fresh end-to-end run after the synthesis/plan fixes. Repeated keyboard calls can trigger the SDK loop guard; guidance now requires focus inspection between steps. Qualify representative customer targets on the intended model before promising unattended completion. |

No production-ready or compliance certification is asserted by this report.

## Evidence files and reproduction

Source-level commands and environment requirements are documented in
[README](../README.md#verification). Generated evidence is local and ignored by Git:

- [Full verification log](../test-results/final-verification.log)
- [Dashboard results and screenshots](../test-results/dashboard/result.json)
- [Final QA microphone/meeting report](../test-results/agent-qa-media-1788961804175/report.md)
- [Original full QA report](../test-results/agent-qa-1788914640420/report.md)
- [SQA report](../test-results/agent-sqa-1788914673240/report.md)
- [Fresh SQA timeout result](../test-results/agent-sqa-1788979502229/result.json)
- [Completed SQA recovery report](../test-results/agent-sqa-recovered-1788980668441/report.md)
- [Recovered Founder report](../test-results/agent-founder-recovered-1788961656912/report.md)
- [Fresh complete Founder report](../test-results/agent-founder-1788979516744/report.md)
- [Original Founder timeout result](../test-results/agent-founder-1788914790380/result.json)
- [Dependency audit after patches](../test-results/dependency-audit-after.json)

Each model-output directory includes `session.json` and `result.json` with
activities, completion state, coverage, and elapsed time. The recovery result
identifies its source session. Early interrupted trials are excluded from pass
counts. Keep these local artifacts with the release evidence if distributing
this report; source-only packaging intentionally excludes them and user secrets.

The updated source archive is `qase-share.zip`; packaging checks confirmed that
it includes the verification workflow and excludes API keys, saved run history,
dependencies, and generated evidence. Existing running Qase processes must load
the changed source during the normal service rollout; this task did not restart
or deploy the user's existing service.
