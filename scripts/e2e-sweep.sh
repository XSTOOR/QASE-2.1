#!/bin/bash
# #17997 regression sweep: chunked, sequential (process-limit safe), records per-file tests/pass/fail.
cd /workspace
mkdir -p /workspace/test-results/sweep
FILES=$(ls server/*.test.js public/*.test.js 2>/dev/null | sort)
N=0
for f in $FILES; do
  N=$((N+1))
  OUT=/workspace/test-results/sweep/$(echo "$f" | tr '/' '_').txt
  if [ -f "$OUT" ]; then continue; fi
  summary=$(timeout 180 node --test "$f" 2>&1 | grep -E "^ℹ (tests|pass|fail) " | awk '{print $3}' | paste -sd/)
  echo "$summary" > "$OUT"
  echo "[$N] $f $summary"
done
echo "SWEEP COMPLETE"
