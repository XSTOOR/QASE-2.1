# Founder Mode / Studio handoff — exploration map (for Mishal's "Founder Mode" task)

Surveyed 2026-10, branch DEV @b382093.

## Key files
- Founder backend: server/founderSchema.js (taxonomy, bounded validators — NO zod, hand-rolled), founderService.js (state, observations, finishFounderReview, markdown), founderPrompt.js (buildFounderContext + buildFounderSynthesisContext), founderTools.js (record_founder_observation, finish_founder_review tool schemas/readiness gates).
- Routes: server/app.js — POST /api/founder/sessions (~850), GET /api/founder/catalog (~462); report via GET /api/sessions/:id/report.md (founder branch 409-until-finalized).
- Frontend: public/app.js (founderUi launcher ~4675, SSE founder.* cases ~3792), public/founderView.js (render/renderReportTab, download .md/.pdf/copy), public/founderPresentation.js, index.html #founder-start dialog.
- Persistence: local .qase/sessions.json via server/store.js; Postgres server/postgres/runRepository.js — qa_runs.founder_assessment JSONB (migration 009, 1MiB CHECK, mutually exclusive with qa/sqa). Durable events founder.created/target_bound/observation/finalized.
- Model: @cleanslate/sdk CleanSlateNodeAgentRuntime + createNodeProviderConfiguration (server/agent.js ~396). Provider from /api/config (env QASE_PROVIDER/QASE_API_KEY/QASE_BASE_URL/QASE_MODEL; live: custom → https://llm.drytis.ai, z-ai/glm-5.2). Structured output = tool parameterSchemas validated host-side; NO zod/pydantic.
- Tenancy: server/tenancy.js — single project per instance (QASE_BOOTSTRAP_PROJECT_*), no multi-project selection in-app. Drytis projectContext arrives via signed internal API only (server/drytisIntegrationSchema.js normalizeDrytisProjectContext), stored in qa_runs.drytis_integration (migration 010) but DB CHECK restricts it to run_mode='qa' — gap for founder.
- Studio handoff: live-but-optional. QASE_DRYTIS_INTEGRATION_ENABLED + HMAC (server/drytisIntegrationFactory.js); /internal/v1/drytis review API (server/drytisIntegrationApi.js); dashboard push POST /api/sessions/:id/drytis/push (findings→tickets, QA-only: requires session.drytisIntegration); client adapter integrations/drytis/qaseClient.js; docs/drytis-studio-integration-architecture.md. NOTE: qa_runs_mode_shape CHECK forbids drytis_integration on founder runs.
- Auth: cookie qase_session + qase_csrf double-submit (server/auth.js), /api middleware in app.js ~214 (authRequired default true), per-user isolation via session.ownerUserId (store.js getSession/listSessions).
- Tests: node:test, `npm test` = node --test server/*.test.js server/postgres/*.test.js server/controlPlane/*.test.js (~833). Founder: founderService/Prompt/Tools/Ui/ReportCompletion/Presentation .test.js. Mocking: fake runStore objects, fetchImpl injection (drytisStudioClient.test.js); no LLM provider mock.

## Avoid touching
- React UI rebuild phases 5–7 (public/app-react, .drytis/specs/react-ui-phases-5-7.md) — SQA/Founder tabs not yet built there; teammate work.
- SQA/compliance mode (sqa*.js, #qa-compliance checkbox).
- QA security test selection/classifier (qaTestCatalog, securityChecks, migrations 021/022).
- Bugs view, WhatsApp notifications, feedback v2/v3 (MANOJ), device catalog/environments/test-cases (NIHARIKA/PUSHKAR history).

## Gaps found
- No project-context Markdown convention; no previous-QA-findings feed into Founder prompt.
- Studio handoff payload (tickets) is findings-shaped, QA-only; no recommendation→ticket path for founder.
- drytis_integration column CHECK run_mode='qa' blocks founder runs carrying Studio linkage at DB level.
