# Ticket #16225 — QA runs not initializing / not completing on production

## Root causes (two, both verified on prod 2026-10-13)

### RC1: Chromium system libs lost + broken dependency preflight
After the 22:31 rolling restart, prod lost apt-installed Chromium libs (outside the
persistent volume). The background-service preflight passed bookworm AND trixie
package names to ONE `apt-get install` call; on Debian 12 the t64 names don't
resolve → apt aborts the whole batch → `libglib2.0-0` never installed → every
health gate failed `engine_launch` → runs sat QUEUED ("not getting initialized").
**Fix:** per-package install, each name resolved via `apt-cache show` first
(background service 4182 script, updated + pushed via update_production_config).

### RC2: owner-scoped runs.get() in the boot-resumed orchestrator (#16159 regression amplifier)
`services.runs.get(id)` filters by the ambient actor (request actor → tenantContext
default `4a7f5cf0…`). Matrix sessions carry the RUN OWNER's id (`621ab318…`).
- Started via API: fire-and-forget inherits the request actor → get() works.
- Resumed at boot by #16159 strand-recovery (no actor): get() returns undefined →
  waitForSession stamps every item ERROR "Session … disappeared" while the
  ORPHANED session keeps running (browser + RAM leak) → OOM-kill loop
  (4× node killed; cgroup 4 GB) → repeat. 138 sessions orphaned, ~10k queued
  items across 20 zombie runs re-resumed each boot.

**Fix:** orchestrator polls through `peekSessionUnscoped()` (runs.peek /
runs.getAny / runs.getUnscoped fallbacks); `peek(id)` added to localServices
(unscoped, never exposed over HTTP); Postgres already had `getAny`.

## Cleanup on prod (part of this ticket)
- 20 stale runs from 17:11–21:39 (~9,900 queued items, 16.5k total) must be
  cancelled/errored once, so recovery stops re-resuming them each boot.

## Acceptance criteria
- [x] Chromium launch probe OK on prod (Example Domain navigated).
- [x] Preflight installs per-package, skipping unresolvable names (service script updated).
- [x] Orchestrator session polling is owner-unscoped; regression test + negative
      control both green (matrixOrchestrator.test.js 26→28 tests, localServices pass).
- [ ] Prod: new runs initialize AND complete (item reaches terminal status with verdict).
- [ ] Prod: "disappeared" errors stop appearing; no further OOM kills.
- [ ] Stale 20-run backlog cleared.
