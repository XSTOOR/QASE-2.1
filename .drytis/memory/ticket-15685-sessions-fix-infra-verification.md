# Ticket #15685 infra verification (2026-10-08) — PASS

Focused audit of the POST /api/sessions fix (dead block removal + scopeSelection persistence):

- `server/app.js:1707-1742`: exactly ONE `services.runs.create` call in the handler; `engine` is defined at line 1711 inside the try and referenced only inside the try (no post-catch dead block remains). `scopeSelection` normalized (1724) and passed through to the run create (1730, conditional spread) — persistence restored as claimed.
- Full 7-point infra audit also clean: 33/33 env keys match backend; no hardcoded secrets/URLs in server/ public/ scripts/; qase-server (service-bg-service-4182) running `exec node server/index.js`, no dev processes; preview 200/88KB Qase app; Caddy / → 5173 matches PORT=5173; setup script has `npm ci` (no `build` script exists in package.json — none required) and conditional postgres migrate; migrations dir present, raw CREATE/ALTER TABLE only in server/postgres/migrations and server/controlPlane/migrations (latter is its own migrations dir, acceptable).

Only WARN: `QASE_BROWSER_ALLOWED_PRIVATE_HOSTS` embeds the literal preview hostname `qase-2-1-cvtryq.drytis.dev` (env key 50925, order 14, refreshed 2026-10-08). It has drifted before (#14276); on a redeploy that changes the preview host this key must be manually updated or the agent's /demo/security fixtures on the own host will be blocked. A `{{DOMAIN}}`-templated value would be more robust.
