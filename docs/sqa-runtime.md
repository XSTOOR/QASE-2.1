# SQA browser prerequisites

SQA uses the selected environment's browser engine: Safari maps to WebKit,
Firefox to Firefox, and Chromium-family browsers to Chromium. A Safari run is
never retried as Chromium or reported as physical-device coverage.

Install the required bundles on the server under the same OS account that runs
QASE:

```powershell
npx playwright install chromium webkit
```

Install Firefox too when offering Firefox environments. On Linux, install the
Playwright system dependencies. The engine resolver uses Playwright's native
executable paths on Windows/macOS and retains the GTK/Xvfb workaround where a
Linux GTK bundle exists; no Playwright revision or HOME cache path is hardcoded.

The SQA creation route preflights execution support and local bundle availability
before creating the session. Remote devices do not require local browser bundles.
A rejected selection returns an actionable 422 error in the launcher without
starting the model. Binary existence is not a full launch-health guarantee;
launch-time OS/permission failures remain real runtime blockers.

## Regression verification

```powershell
node --test server/browserEngines.test.js server/sqaRuntime.test.js
node --test server/sqaRuntime.integration.test.js server/runtimeFacts.integration.test.js
```

The browser integration test launches real WebKit, verifies positive and negative
form behavior in an isolated local document, and records an attributable SQA
control result. It does not claim to certify a production application.

The historical drytis.com SQA run `1d0fce5f-80eb-4854-96cb-5f269658eb00`
never opened a page because its iPad/Safari selection hit a missing Linux GTK
bundle check on Windows. Its original blocked result is preserved. Start a new
assessment after deploying the fix; reviewer-only assurance artifacts may still
be legitimately blocked when no supporting documents have been supplied.
