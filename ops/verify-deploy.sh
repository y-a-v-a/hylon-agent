#!/bin/bash
# Verify the live public site after a deploy.
# Usage: npm run verify:deploy <base-url>   (e.g. https://works.example.com)
# Exits non-zero if any check fails, so it's usable in a pipeline.
set -u
cd "$(dirname "$0")/.." || exit 1
BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "usage: npm run verify:deploy -- <base-url>"
  exit 2
fi
fail=0

code() { curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$1"; }
expect() { # description expected actual
  if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; else echo "  FAIL $1 (expected $2, got $3)"; fail=1; fi
}

echo "verifying $BASE"

expect "catalogue /" 200 "$(code "$BASE/")"

# CSP header present and restrictive (the self-containment backstop)
csp=$(curl -s -D - -o /dev/null --max-time 15 "$BASE/" | grep -i "content-security-policy")
if echo "$csp" | grep -qi "connect-src 'none'"; then
  echo "  ok   CSP present (connect-src 'none')"
else
  echo "  FAIL CSP missing or weak: ${csp:-<none>}"; fail=1
fi

# Probe the oldest published work (certainly deployed)
id=$(ls -1 workspace/published 2>/dev/null | grep -v '^\.gitkeep$' | sort | head -1)
if [ -n "$id" ]; then
  expect "work /$id/" 200 "$(code "$BASE/$id/")"
  expect "motivation /$id/motivation.md" 200 "$(code "$BASE/$id/motivation.md")"
  expect "jury.json stays private /$id/jury.json" 404 "$(code "$BASE/$id/jury.json")"
else
  echo "  (no published work to probe)"
fi

if [ "$fail" = 0 ]; then echo "DEPLOY OK"; else echo "DEPLOY CHECK FAILED"; fi
exit "$fail"
