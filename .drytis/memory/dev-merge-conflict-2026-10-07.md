# DEV → PUSHKAR merge attempt (2026-10-07): BLOCKED — conflict

## What happened
- User asked to pull DEV into PUSHKAR (HEAD 0ff4721, ahead 15 of origin/PUSHKAR).
- `git fetch origin` on /workspace fails reliably: "remote end hung up unexpectedly"
  during have-negotiation (server drops conn mid-handshake; tried retries, postBuffer,
  HTTP/1.1, protocol v2/v0, --depth variants — all fail). `git ls-remote` works.
  Root cause is likely shallow-clone negotiation vs server. **Workaround: fresh
  `git clone --depth 50 --branch DEV` to /tmp succeeds, then fetch from the local
  clone via `git remote add devmirror /tmp/qase-dev`.**
- DEV tip = 820a165 "Fix #14942 413 on full-matrix QA run". 84 commits on DEV not on
  PUSHKAR; 21 on PUSHKAR not on DEV; multiple merge bases (criss-cross history).
  Impact: 555 files, +43129/−1841.

## Trial merge → conflicts in 9 files (merge aborted, workspace restored)
- public/app.js, public/index.html, public/styles.css
- scripts/qualify-dashboard.mjs
- server/app.js, server/founderUi.test.js
- server/postgres/migrations.test.js
- server/postgres/runRepository.js, server/postgres/runRepository.test.js

## State left behind
- /tmp/qase-dev removed, devmirror remote removed. PUSHKAR clean, untracked notes
  and userDocs pngs remain. origin/DEV ref in workspace may be stale (fetch broken).

## Next step needs human/leader decision on conflict resolution (especially
server/app.js, runRepository.js, public/app.js).