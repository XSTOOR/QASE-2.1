# matrixService.test SIGABRT flake (2026-10-08) — PID exhaustion, NOT a test bug

`node --test server/matrixService.test.js` intermittently reports the FILE itself
as failed ('test failed', signal SIGABRT) while all 21-22 subtests show ✔ pass —
and running the same file directly (`node server/matrixService.test.js`) exits 0
reliably (3/3 clean after container restart).

Root cause: the container's known PID-exhaustion condition (see
incident-pid-exhaustion-zombies.md) — when zombies approach RLIMIT_NPROC, the
test-runner's internal fork of the test file fails mid-flight and node --test
reports the outer file as failed even though every subtest passed. Container
restart is the only recovery.

Verification protocol for matrixService tests:
1. If all subtests print ✔ but the file line shows ✖ 'test failed': check
   `run_bash` fork health (a failing fork = PID exhaustion).
2. Restart container, then `node server/matrixService.test.js` directly — exit 0
   = suite actually green.
Never chase the SIGABRT as a code regression when forks are failing.
