#!/usr/bin/env bash
# restart-all.sh — one-shot restart of the entire quartz_pty + claude_pty
# stack: every quartz dev-server and every bridge, each from its OWN
# worktree, in dependency order. Then verify each and print a table.
#
# Why this exists: restarting by hand means juggling 6 components across
# 6 worktrees with 3 different start mechanisms. Easy to (a) miss one or
# (b) start a bridge from the wrong checkout — which is exactly what
# produced the "PTY start failed: Failed to fetch" bug (a rollback
# checkout ended up serving :3000 with no CORS-preflight support, so the
# browser's OPTIONS /api/sessions got a 404 and fetch() threw).
#
# Components, restarted in THIS order (bridges before quartz, because
# quartz run.sh health-checks its bridge on start):
#
#   1. prod    bridge   claude_pty_prod      :3000
#   2. staging bridge   claude_pty_staging   :3001
#   3. dev     bridge   claude_pty           :3210   (PORT=3210 node server.js)
#   4. prod    quartz   quartz_pty_prod      :8080
#   5. staging quartz   quartz_pty_staging   :8081
#   6. dev     quartz   quartz_pty           :8090   (npx quartz --serve)
#
# Verification: quartz → HTTP 200 on /. bridges → /api/health responds
# AND the CORS preflight on /api/sessions returns access-control-allow-*
# (catches the wrong-checkout bug) plus the git branch it's serving.
#
# Usage:  bash scripts/restart-all.sh
# No args. To restart a single stack, use scripts/run.sh in that worktree.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WS="$(cd "$REPO/.." && pwd)"

CL_PROD="$WS/claude_pty_prod"
CL_STAGING="$WS/claude_pty_staging"
CL_DEV="$WS/claude_pty"
QZ_PROD="$WS/quartz_pty_prod"
QZ_STAGING="$WS/quartz_pty_staging"
QZ_DEV="$REPO"

c_bold=$'\033[1m'; c_red=$'\033[31m'; c_grn=$'\033[32m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
fail=0
declare -a ROWS

step()   { printf '\n%s▸ %s%s\n' "$c_bold" "$1" "$c_off"; }
indent() { sed 's/^/   /'; }

# Poll a URL until curl succeeds, up to <tries> seconds.
wait_url() {
  local url="$1" tries="${2:-30}" i
  for ((i = 0; i < tries; i++)); do
    curl -fsS -m 2 -o /dev/null "$url" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

# SIGTERM then SIGKILL whatever LISTENs on a TCP port (used for the dev
# components, which have no role-pinned stop.sh).
kill_port() {
  local p="$1" pid
  pid="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [[ -n "$pid" ]]; then
    echo "   freeing :$p (PID $pid)"
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
}

# Verify a bridge: health responds + CORS preflight returns the header
# the browser needs. quartz_port is the Origin we test the preflight with.
verify_bridge() {
  local role="$1" port="$2" quartz_port="$3"
  local branch cors
  branch="$(curl -fsS -m 3 "http://127.0.0.1:$port/api/health" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version.gitBranch||"?")}catch{console.log("?")}})' 2>/dev/null || echo "?")"
  cors="$(curl -s -m 3 -D - -o /dev/null -X OPTIONS "http://127.0.0.1:$port/api/sessions" \
    -H "Origin: http://localhost:$quartz_port" \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type,x-role-id' 2>/dev/null \
    | grep -i '^access-control-allow-origin:' || true)"
  if [[ -n "$cors" ]]; then
    ROWS+=("bridge|$role|:$port|${c_grn}OK${c_off}  ${c_dim}CORS ok · $branch${c_off}")
  else
    ROWS+=("bridge|$role|:$port|${c_red}NO CORS — PTY will fail${c_off}  ${c_dim}$branch${c_off}")
    fail=1
  fi
}

# prod / staging bridge — has scripts/{stop,run}.sh in its worktree.
restart_bridge() {
  local role="$1" dir="$2" port="$3" quartz_port="$4"
  step "bridge $role  ($dir → :$port)"
  if [[ ! -d "$dir" ]]; then
    ROWS+=("bridge|$role|:$port|${c_red}MISSING WORKTREE${c_off}"); fail=1; return
  fi
  ( cd "$dir" && bash scripts/stop.sh "$role" 2>&1; bash scripts/run.sh "$role" 2>&1 ) | indent
  if wait_url "http://127.0.0.1:$port/api/health" 25; then
    verify_bridge "$role" "$port" "$quartz_port"
  else
    ROWS+=("bridge|$role|:$port|${c_red}DOWN (no /api/health)${c_off}"); fail=1
  fi
}

# dev bridge — plain `PORT=3210 node server.js` from the claude_pty dev
# tree; no role-pinned worktree, so it's stopped by port.
restart_dev_bridge() {
  local dir="$CL_DEV" port=3210
  step "bridge dev  ($dir → :$port)"
  if [[ ! -d "$dir" ]]; then
    ROWS+=("bridge|dev|:$port|${c_red}MISSING WORKTREE${c_off}"); fail=1; return
  fi
  kill_port "$port"
  mkdir -p "$dir/.pids" "$dir/.logs"
  (
    cd "$dir" || exit 1
    PORT="$port" nohup node server.js >> .logs/dev-bridge.log 2>&1 &
    pid=$!
    disown "$pid" 2>/dev/null || true
    echo "$pid" > .pids/dev-bridge.pid
    echo "   started node server.js PID $pid"
  )
  if wait_url "http://127.0.0.1:$port/api/health" 25; then
    verify_bridge dev "$port" 8090
  else
    ROWS+=("bridge|dev|:$port|${c_red}DOWN (no /api/health)${c_off}"); fail=1
  fi
}

# prod / staging quartz — role-pinned worktree with scripts/{stop,run}.sh.
restart_quartz() {
  local role="$1" dir="$2" port="$3"
  step "quartz $role  ($dir → :$port)"
  if [[ ! -d "$dir" ]]; then
    ROWS+=("quartz|$role|:$port|${c_red}MISSING WORKTREE${c_off}"); fail=1; return
  fi
  ( cd "$dir" && bash scripts/stop.sh "$role" 2>&1; bash scripts/run.sh "$role" 2>&1 ) | indent
  if wait_url "http://127.0.0.1:$port/" 40; then
    ROWS+=("quartz|$role|:$port|${c_grn}OK${c_off}  ${c_dim}HTTP 200${c_off}")
  else
    ROWS+=("quartz|$role|:$port|${c_red}DOWN${c_off}"); fail=1
  fi
}

# dev quartz — `npx quartz build --serve`; no role script, stopped by port.
restart_dev_quartz() {
  local dir="$QZ_DEV" port=8090 ws=3020
  step "quartz dev  ($dir → :$port, ws :$ws)"
  kill_port "$port"
  kill_port "$ws"
  mkdir -p "$dir/.pids" "$dir/.logs"
  (
    cd "$dir" || exit 1
    nohup npx quartz build --serve --port "$port" --wsPort "$ws" >> .logs/dev.log 2>&1 &
    pid=$!
    disown "$pid" 2>/dev/null || true
    echo "$pid" > .pids/dev.pid
    echo "   started quartz dev PID $pid"
  )
  if wait_url "http://127.0.0.1:$port/" 60; then
    ROWS+=("quartz|dev|:$port|${c_grn}OK${c_off}  ${c_dim}HTTP 200${c_off}")
  else
    ROWS+=("quartz|dev|:$port|${c_red}DOWN${c_off}"); fail=1
  fi
}

printf '%srestart-all — restarting the full quartz_pty + claude_pty stack%s\n' "$c_bold" "$c_off"

restart_bridge prod    "$CL_PROD"    3000 8080
restart_bridge staging "$CL_STAGING" 3001 8081
restart_dev_bridge

restart_quartz prod    "$QZ_PROD"    8080
restart_quartz staging "$QZ_STAGING" 8081
restart_dev_quartz

printf '\n%s── status ──────────────────────────────────────────────%s\n' "$c_bold" "$c_off"
for r in "${ROWS[@]}"; do
  IFS='|' read -r kind role port status <<<"$r"
  printf '  %-7s %-8s %-7s %b\n' "$kind" "$role" "$port" "$status"
done

if [[ "$fail" -ne 0 ]]; then
  printf '\n%s✗ one or more components failed — see above%s\n' "$c_red" "$c_off"
  exit 1
fi
printf '\n%s✓ all 6 components up%s\n' "$c_grn" "$c_off"
