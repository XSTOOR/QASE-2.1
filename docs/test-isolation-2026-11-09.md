# Application test data isolation

The UI follow-up audit found that broad test runs could update the developer's
anonymous analytics counters and append synthetic feedback records. Several
API fixtures imported application modules before selecting a temporary working
directory. Those modules capture local store paths when they load, including
paths used by application analytics when the run service itself is mocked.

The affected API, credential, recovery, artifact and runtime fixtures now
import `server/testWorkingDirectory.js` before
application dependencies. Each test process enters its own temporary directory
before any local store paths are initialized. The shared teardown returns to
the caller directory and removes only the directory it created, with explicit
parent/prefix checks and bounded retries for Windows file handles.

`server/testWorkingDirectory.test.js` creates disposable caller data, including
feedback, analytics, sessions and an environment file. Its negative control
uses the real feedback store and analytics writer to reproduce the old writes
and prove the checks detect them. It then restores only those controlled
fixtures, runs 30 affected suites and compares every caller file checksum
and directory entry. Existing records, byte changes and newly created files
are all covered, including newly created credential keys, recovery snapshots
and artifact files. No real gateway key or notification service is used.

Environment-health tests also use a local HTTP server instead of a public
website. They exercise real HEAD requests, successful responses, a disconnected
socket, HTTP error responses and cache/force behavior. The production probe,
its timeout and fail-closed behavior are unchanged.

Run the regression with:

```sh
node --test server/testWorkingDirectory.test.js
```

Both `npm test` and `npm run verify` include the regression. The Linux/Windows
SQA acceptance workflow runs it explicitly as well. New test files that
use local application state must import the working-directory fixture before
application dependencies and join the caller-data regression's suite list.
Prefer a disposable source checkout for broad verification.

This change concerns test execution. SQA evidence requirements, budgets,
assessment decisions and published report behavior retain their existing
contracts. The next product phase is SQA evidence coverage and control
prioritization; live Studio delivery and production activation still require
separate qualification.
