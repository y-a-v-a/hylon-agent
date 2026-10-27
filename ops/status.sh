#!/bin/bash
# Agent health check — is the daemon alive, serving, and on schedule?
# Usage: npm run status   (or: bash ops/status.sh)
set -u
cd "$(dirname "$0")/.." || exit 1
LABEL="com.agent.hylon"
PORT=$(node -p "JSON.parse(require('fs').readFileSync('agent.config.json','utf8')).dashboard.port" 2>/dev/null || echo 4737)

echo "── launchd ──────────────────────────────"
line=$(launchctl list | awk -v l="$LABEL" '$3==l {print}')
if [ -n "$line" ]; then
  pid=$(echo "$line" | awk '{print $1}')
  exitcode=$(echo "$line" | awk '{print $2}')
  if [ "$pid" != "-" ]; then
    echo "  RUNNING — pid $pid, last exit $exitcode"
  else
    echo "  loaded but NOT running (last exit $exitcode) — KeepAlive should restart it"
  fi
else
  echo "  NOT loaded. Start with:"
  echo "    npm run daemon:install && npm run daemon:start"
fi

echo "── dashboard ────────────────────────────"
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:$PORT/" 2>/dev/null || echo down)
echo "  http://localhost:$PORT -> $code"

ADMIN_PORT=$(node -p "(JSON.parse(require('fs').readFileSync('agent.config.json','utf8')).admin||{}).port||4747" 2>/dev/null || echo 4747)
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:$ADMIN_PORT/" 2>/dev/null || echo down)
echo "  admin console http://localhost:$ADMIN_PORT -> $code (npm run admin)"

echo "── wakes ────────────────────────────────"
grep -E "wake (start|done|error)|^\[daemon\].* up\." logs/daemon.out.log 2>/dev/null | tail -4 || echo "  no log yet"

echo "── today's spend (fuse) ─────────────────"
if [ -f .agent-state.json ]; then cat .agent-state.json; else echo "  nothing spent today"; fi

echo "── pending awaiting your approval ───────"
ls -1 workspace/pending 2>/dev/null | grep -v '^\.gitkeep$' | sed 's/^/  /' || true
[ -z "$(ls -1 workspace/pending 2>/dev/null | grep -v '^\.gitkeep$')" ] && echo "  (none)"

echo "── orphaned (finished, never juried) ────"
orphans=$(ls -1 workspace/orphaned 2>/dev/null | grep -v '^\.gitkeep$')
if [ -n "$orphans" ]; then
  echo "$orphans" | sed 's/^/  /'
  echo "  re-jury with: npm run orphans -- rejury <id>"
else
  echo "  (none)"
fi
