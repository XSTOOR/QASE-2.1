# Hybrid QA qualification renewal — 5 November 2026

## Cause

The screenshot is a model-gateway qualification failure, not a missing browser.
`validateQualification()` deliberately expires compatibility proof after 24 hours.
The old **Refresh model status** button issued only `GET /api/config`: it read
the same expired file and could never renew it.

The distributed Kubernetes template also mounts separate ephemeral `.qase`
directories in API and worker pods. A certificate written in an API pod's local
directory was not shared with the workers that enforce the same gate.

## Fix

- **Check model compatibility** now calls the operator-only
  `POST /api/config/hybrid/qualification` route, then polls read-only config
  status. Review stays disabled until the host reports verified availability.
- The route uses the current account's effective credentials and fixed model
  endpoints. Request bodies cannot supply keys, endpoints or identities. Existing
  authentication, CSRF and origin checks apply; only owner/admin/developer roles
  can trigger billable probes. Pilot, viewer and unknown roles are rejected.
- API renewal and the CLI use the same installed-CleanSlate probe, including
  all 13 existing capabilities: text, streaming, tools, multiple calls,
  continuation, image input, structured output, cancellation, timeouts, exact
  usage, native SDK execution, SDK usage and JEV decisions.
- Duplicate starts in one process share a job, concurrency is limited to one
  probe per process, failures have a one-minute retry backoff, and the probe has
  a 180-second deadline. Configuration GETs never start model calls.
- Certificates are profile/key-bound, atomically replaced, and private
  (`0600`). Failed checks, unverified usage or storage failures cannot unlock
  execution. The 24-hour expiry and feature flags are unchanged.
- Distributed mode uses
  `$QASE_ARTIFACT_DIR/qualifications/hybrid` when shared artifact storage is
  configured. `QASE_HYBRID_QUALIFICATION_DIR` can select another shared directory;
  an explicit `QASE_HYBRID_QUALIFICATION_FILE` still takes precedence. Local
  mode keeps its existing path. Distributed readers cannot fall back to a
  pod-local legacy certificate when shared proof is absent.
- The launcher preserves URL, goal, browser selection and checks while renewal
  runs. Errors remain visible and retry/reconnect remains available. The UI
  cache/version stamp is updated to `20261105-1` for the existing stale-tab
  refresh mechanism. No new agent mode or fallback was introduced.

## Verification

- **13/13 real gateway checks passed** through the shared CLI probe.
- A separate real renewal started from a deliberately expired isolated file:
  `expired → qualification_running → ready → ready after service restart`.
  All 13 checks passed; duplicate starts shared one job. Artifact:
  `test-results/qualification-live-renewal/result.json`.
- Real browser/HTTP launcher validation passed **13 scenarios**, including
  expired-to-ready recovery, retained setup, disabled Review during checking,
  failed-check refusal and retry. This UI harness uses deterministic
  qualification responses; its model-call count is explicitly zero. The real
  model checks above are separate. Artifacts/screenshots:
  `test-results/qualification-renewal-ui/`.
- Focused service/gateway/launcher unit suite passed 17 tests before the final
  legacy-path guard; the final storage/UI-version suite passed 20 tests.
  The actual HTTP/account-scope regression suite passed 68 tests, including
  operator restrictions, cross-origin rejection, payload override rejection and
  concurrent account credential isolation. These suites overlap.
- Full project regression and final source-manifest results are recorded in the
  verification addendum below. No test total includes an unexecuted check.

Initial UI fixture attempts exposed two test synchronization errors: checking
checkbox geometry before the launcher became visible, and filling the goal on
the hidden wizard step. The fixture now waits for visibility and fills inputs
on the website step. No application timeout or assertion was weakened.

## Current production instance

This change is in the local working tree. It has **not** been committed, pushed
or deployed to `qase.drytis.com`; no production credentials/configuration or
feature flags were changed.

To recover the already deployed instance immediately, an operator can run the
existing command **inside that QASE deployment**, from its project directory,
with its effective gateway credentials and writable qualification storage:

```sh
npm run qualify:hybrid-gateway
```

Refresh the page only after all checks pass. Running this on a development Mac
does not update the production instance. The certificate must match the actual
account key; a certificate for a different server/account key will be rejected.

After an approved release containing this patch, an operator can use the new
button instead. To avoid scheduled expiry, operators can schedule the same CLI
checks before 24 hours elapse, in the same reviewed image/environment and shared
storage. No scheduler or automatic model spending was enabled by this change.

API/worker certificate storage must be shared and writable by the service UID.
Real Kubernetes/RWX-volume behavior is not qualified on this Mac. In-flight job
status and deduplication are process-local; polling tolerates another replica's
stale status until the shared certificate becomes visible. Failed/expired proof
never becomes ready because of elapsed time. Production deployment readiness
remains subject to the infrastructure gates in the earlier engineering report.

## Files

New: `server/hybridQualificationProbe.js`,
`server/hybridQualificationService.js`, its test,
`public/hybridQualification.js`, its test, and this note.

Updated: `server/hybridConfig.js`, `hybridGatewayQualification.js` and its test,
`config.js`, `localServices.js` and its test, `app.js` and its test,
`uiVersion.test.js`; `public/app.js`, `qaBrowserStatus.js` and its test,
`index.html`, `release.json`; `scripts/qualify-hybrid-gateway.mjs`,
`qualify-hybrid-launcher.mjs`; `.env.example` and `SOURCE_MANIFEST.json`.
Existing unrelated working-tree changes remain preserved.

## Verification addendum

`npm run verify` completed 2,219 tests: **2,191 passed, zero failed, 28 skipped**
in 239,014.762 ms. Skips are optional browser/infrastructure qualifications;
they are not counted as passes. Syntax/private-state/source credential checks
passed. The final focused HTTP/credential suite and storage/UI suite above
also cover the subsequent strict role allowlist and legacy-path refusal.
Public/configuration/runtime regressions separately passed 484 tests; totals
overlap and must not be added together.

The final launcher browser run passed all 13 scenarios after the UI version
bump. Final logs are retained in
`test-results/qualification-renewal-verification/`.
`git diff --check` passes. The regenerated source manifest is verified using
the existing release identity; no remote release was published.
