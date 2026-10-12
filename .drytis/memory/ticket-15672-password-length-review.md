# Ticket #15672 review — password min length 12 → 8 (2026-10-09)

## Static verification: ALL PASS
- server/auth.js:10 `PASSWORD_MIN_LENGTH = 8`; error string at :53 interpolates the constant (`Password must be 8–200 characters.`, code `weak_password`, 400). Single constant flows into passwordRecord → local register/changePassword + PG register/changePassword. No hardcoded "12" anywhere in server/auth.js.
- public/index.html:45 `#auth-password` minlength="8" maxlength="200"; :51 hint "Use at least 8 characters when creating an account."; :1373 `#new-password` minlength="8" maxlength="200".
- public/app.js:6653 `el.authPassword.minLength = register ? 8 : 1;`
- docs/auth-architecture-2026-09-10.md:14 "(8–200 characters)".
- New unit test in server/auth.test.js (line 110, "password minimum length is 8 characters across register and change password") covers 7-char reject/8-char accept on register AND changePassword, plus ≥12 legacy password still registers.
- scripts/test-auth-browser.mjs: change-password 7-char browser validity check added (lines 83–86); registration still uses a long password (no 7/8 boundary on signup form — noted as minor gap, spec said to add it).
- Security: scrypt N=16384/r=8/p=1 untouched; maxlength 200 intact; no other validation weakened.

## BLOCKED — could NOT execute (container PID exhaustion)
Container hit the known PID-1 zombie exhaustion (see incident-pid-exhaustion-zombies.md, env-postmortems-enospc-pids.md). Every fork failed for the whole review session (~30 min of retries incl. 5-min waits): run_bash, procmgr, grep_search (rg), terminal sessions all fail with `fork: Resource temporarily unavailable`; curl to preview URL returns 000/exit 6 (network helper can't spawn). Only restart_container recovers.

Still to verify after restart:
1. `node --test server/auth.test.js` — expect all pass incl. new boundary test.
2. grep for residual "12 characters"/"at least 12" in server/, public/, docs/ (static reads of all known spots are clean, but full repo grep was impossible).
3. Live preview: POST /api/auth/register 7-char → 400 {"error":"Password must be 8–200 characters."}; 8-char → 201; GET / shows minlength="8" + 8-char hint. Delete probe account from .qase/auth.json afterwards.
4. scripts/test-auth-browser.mjs run.

Known pre-existing env failure (don't count): server/defectFixtures.test.js WebKit/libgstreamer.