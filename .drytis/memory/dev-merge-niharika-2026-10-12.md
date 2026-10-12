# DEV → NIHARIKA merge (2026-10-12, ticket #14189) — FINAL STATE

- Merge commit **807bd76** (origin/DEV c959803 → NIHARIKA) + fix **545ac1f** on NIHARIKA. NOT YET PUBLISHED (origin/NIHARIKA at 807bd76's parent — wait, origin/NIHARIKA == 807bd76? No: origin/NIHARIKA points at 807bd76? Verify with `git status` — HEAD is 545ac1f ahead of origin/NIHARIKA=807bd76? Actually `git log` showed `807bd76 (origin/NIHARIKA)` as parent of 545ac1f, so ONE commit (545ac1f) is unpushed. Publish when user approves.
- Resolution rules used: NIHARIKA auth/pipeline wins, DEV UI layered. DEV's 037/038 migrations were byte-duplicates of NIHARIKA's 021/022 → dropped; DEV 039_founder_project_state → 040. Migrations contiguous 1–40, name+checksum strict (server/postgres/migrations.js). No applied PG history existed (QASE_RUN_STORE=local) so no renumber-compat plan was needed.
- Fix 545ac1f: `$('open-settings').onclick` threw on null after DEV's #15651 sidebar redesign and silently killed every handler below it in app.js. Now guarded. If new UI breaks with NO console handlers working, check for null-element binding regressions first.

## Verification results
- Server tests: per-file sweep of final batch (34 files) all green; batches 1–3 green except one isolation-flake (founderService ENOSPC during disk-full — passed after cleanup). public/ 285/285. migrations.test.js 5/5. defectFixtures 6/6.
- Browser: login OK (tester@qase.dev / cred.json), profile dialog + Recovery Codes nav + #qa-security-{auth-note,scope,notes} present; sidebar footer OK; preview 200.

## Container hazards (recurring)
- Full `node --test server/*.test.js` (169 files) exhausts OS threads → fork EAGAIN, wedges even bash; ONLY fix is container restart. Kill orphaned node --test procs early. Run in batches ≤45 files with --test-concurrency ≤6, or per-file. Never leave a timed-out batch running.
- Killing a timed-out batch run is what wedges the thread budget — wait for natural exit when possible.
- Disk: /workspace fills fast from browser downloads + .qase artifacts + .git loose blobs. Freed ~750MB via `git gc --prune=now` (unreachable 138/137/116MB blobs from old commits); cleanup .qase/*.tmp-*, artifacts/*, /tmp/qase-*. Currently 68% used.
- After container restart: webkit deps MUST be reinstalled or MiniBrowser fails on libgstreamer (`sudo apt-get install -y libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 libbacktrace0 libgstreamer-gl1.0-0 libgstreamer-plugins-bad1.0-0` + setup.sh's WEBKIT_EXTRA_DEPS list; then `LD_LIBRARY_PATH=~/.cache/ms-playwright/webkit-2336/minibrowser-wpe/lib` works). Chromium may also need `sudo npx playwright install-deps chromium` (libasound2).
- Branded browsers: /workspace/.local-browsers/{brave,edge,opera} — UNTRACKED, re-extract via setup.sh sections (opera uses opera-gx-stable 136 from deb.opera.com; the awk extraction in setup.sh works,Opera extract WARN was a transient curl fail once). Tests in localBrowserRegistry.test.js assert their presence.
- Playwright headless-shell path: /home/coder/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell (NOT headless_shell; NOT /root).
- Login throttle: in-memory, 10 attempts/account per 15min — wrong-password probes lock out real logins with 429. Restart `node server/index.js` (pid changes; kill the process, procmgr service-bg-service-4182 respawns it).
- Setup script full run (bash /drytis-config/setup.sh) re-installs npm deps AND browsers — takes minutes; prefer running only the needed section.