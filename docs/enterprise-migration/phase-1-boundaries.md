# Phase 1: characterization and application boundaries

Scope: behavior-preserving application extraction. This phase does not add
PostgreSQL, multi-tenancy, Drytis identity, queues or distributed workers.

## Application composition

`server/index.js` is now the executable composition root. It loads the current
local run history, creates the local service adapters, creates the Express
application, installs process signal handling and starts the listener.

`server/app.js` owns HTTP middleware and routes but has no import-time listener,
process signal or local-state loading side effects. Tests supply isolated memory
adapters and listen only on an ephemeral loopback port.

`server/contracts.js` validates the application service boundary:

- run persistence and domain mutations
- event publication and subscription
- model configuration
- credential storage
- report rendering
- agent/browser runtime control
- readiness reporting

`server/localServices.js` adapts the existing file, memory, EventEmitter and
agent implementations to that boundary. The dashboard API and browser-agent
behavior remain on those original implementations in Phase 1.

## Operational probes

- `GET /healthz` returns minimal process liveness and performs no dependency or
  model-provider calls.
- `GET /readyz` reflects initialization of the selected service adapter.
- Both probes are public, non-cacheable and covered by the normal security
  headers.

## Practice-site policy

The deliberately broken `/demo` target remains available during local
development. `NODE_ENV=production` always disables it; `QASE_ENABLE_DEMO=false`
can disable it in other environments. When disabled, the route does not receive
the demo-only inline-script policy and startup does not print its credentials.

Each mounted demo router now owns its own practice-login session set so test or
application instances cannot share demo authentication accidentally.

## Characterization coverage

The Phase 1 HTTP suite covers:

- application creation without startup side effects
- service-contract validation
- public health/readiness and protected application APIs
- development and production demo behavior
- run create, list, detail and delete behavior
- message validation, URL extraction and detached agent failures
- pending answers and credential placeholder safety
- stop, report and configuration routes
- malformed JSON and API 404 responses
- SSE initial-frame delivery and subscription cleanup

The original authentication suite remains unchanged and runs beside these tests.

## Known limitations retained for later approved phases

- Runs still have no organization, project or user ownership.
- Run persistence is still a process-global map mirrored to local JSON.
- Authentication is still the local single-owner implementation.
- The agent, browser state and credential values are still process-local.
- Events are still delivered through one in-process EventEmitter.
- No durable job queue, worker lease or cross-server replay exists.

These limitations are intentional Phase 1 compatibility constraints. Phase 2
will replace the run/domain persistence boundary only after separate approval.
