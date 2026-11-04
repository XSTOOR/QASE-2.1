# Hybrid QA implementation audit and plan

## Repository audit (22 October 2026)

- `server/agent.js` constructs one `CleanSlateNodeAgentRuntime` per run, narrows
  its registry and approval gate, wraps tool execution for activity events, and
  attaches one browser bridge. It owns stream translation, usage harvesting,
  snapshots, cancellation, pause/resume and final publication. SDK 0.1.0 and
  Playwright 1.62.0 are installed. This archive has no `.git` directory.
- `server/jevRuntime.js` currently replaces `runtime.run`, question resume and
  chat for JEV. Hybrid must bypass that replacement and retain the SDK loop.
- `server/browserBridge.js` and `browserPolicy.js` implement scoped navigation,
  request policy, destructive-action approval and the execution ledger. Preview
  capture shares the session browser. Hybrid must serialize all browser tools
  and preserve these gates.
- `server/auth.js`, `requestActor.js`, application `requireSession` and local /
  PostgreSQL services provide authentication, CSRF, account/tenant isolation and
  encrypted settings. API keys stay in server configuration; browser credentials
  are substituted through the existing secret vault.
- `server/store.js` persists local run aggregates. PostgreSQL normalizes fields
  in `server/postgres/runRepository.js`; arbitrary new properties are NOT durable
  there. Hybrid persistence therefore needs an optional additive schema and
  repository mapping, authored but not applied to any production database.
- `qaTools.js` owns finding/report publication and runtime integrity. Existing
  JEV checks attach reproduction metadata but generic model-authored findings
  do not yet have a strict evidence-ledger gate. Hybrid adds that gate only for
  hybrid QA.
- `usageCapture.js`, snapshots in `agent.js`, device-runtime ownership and
  operational execution limits already exist. Existing retry behavior can replay
  QA after a timeout; hybrid needs checkpoint/pause instead of those retries.
- QA, SQA and Founder share construction but have separate tool allowlists,
  prompts and finalizers. Hybrid selection is explicit and QA-only. Old runs
  and their selected strategy must not change when a flag changes.
- SDK `CleanSlateService.chat` accepts cancellation and an output token limit.
  The Node custom-provider client supports native streamed tool calls. Its
  constructor `fetcher` option only covers managed account requests, not custom
  model inference: it cannot be used to claim gateway qualification by mocks.
- `npm test` runs server, PostgreSQL-contract and public UI tests. `npm run
  verify` adds syntax/secret checks. Browser and PostgreSQL live qualifications
  are separate; unavailable services must be reported as unverified/skipped.

## Implementation sequence

1. Qualify the fixed Opus/JEV gateways with harmless protocol fixtures and the
   actual installed SDK loop; persist a credential-free qualification artifact.
2. Add disabled-by-default, explicit QA strategy selection and versioned model
   profiles. Validate capability records, model/config identity and independent
   budgets before constructing a hybrid runtime.
3. Add host-owned immutable evidence, typed scenarios, deterministic completion,
   classification batching/cache, bounded telemetry and recovery checkpoints.
4. Integrate via the existing runtime/tools, preserving the SDK loop. Enforce
   browser serialization, observed controls, safe input policies and completion
   checks before native execution/publication. Preserve legacy modes.
5. Add focused UI evidence/telemetry, local and PostgreSQL persistence contracts,
   safety/recovery tests, and a reproducible equal-fixture benchmark runner.
6. Run changed-component tests, the regression suite and project verification.
   Keep the feature flag off; document qualification, benchmark measurements,
   schema prerequisites, remaining gaps and rollback.

No production deployment, database migration or feature activation is part of
this implementation. Gateway responses, not advertised model names, determine
which capabilities can be recorded as qualified.
