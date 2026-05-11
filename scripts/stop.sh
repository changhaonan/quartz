#!/usr/bin/env bash
# Stop the dev server started by scripts/run.sh.
#
# Usage:
#   scripts/stop.sh prod
#   scripts/stop.sh staging

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

role="${1:-}"
if [[ "$role" != "prod" && "$role" != "staging" ]]; then
  echo "usage: $0 {prod|staging}" >&2
  exit 2
fi

worktree_cfg="node $repo_root/scripts/_worktree-config.cjs"
configured_role="$($worktree_cfg read role 2>/dev/null || true)"
if [[ -n "$configured_role" && "$configured_role" != "$role" ]]; then
  echo "This worktree is pinned to '$configured_role'; cannot stop '$role' from here." >&2
  exit 1
fi

pid_file="$repo_root/.pids/$role.pid"
if [[ ! -f "$pid_file" ]]; then
  echo "no pidfile at $pid_file — nothing to stop"
  exit 0
fi

pid="$(cat "$pid_file" 2>/dev/null || true)"
if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
  echo "pidfile present but PID $pid not running — cleaning up pidfile"
  rm -f "$pid_file"
  exit 0
fi

echo "[stop.sh $role] sending SIGTERM to PID $pid"
kill "$pid" 2>/dev/null || true

# Wait briefly; if still alive, escalate to SIGKILL. The quartz dev
# server has child processes (esbuild, etc) that get cleaned up via the
# pgroup; nohup'd parent dying takes them with it on most setups.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 0.5
done
if kill -0 "$pid" 2>/dev/null; then
  echo "[stop.sh $role] PID $pid did not exit; sending SIGKILL"
  kill -9 "$pid" 2>/dev/null || true
fi

# Also reap any lingering child processes by port. Sometimes the dev-server
# parent dies cleanly but a child esbuild/serve worker keeps the port held.
quartz_port="$(node "$repo_root/scripts/_worktree-config.cjs" read quartzPort)"
ws_port="$(node "$repo_root/scripts/_worktree-config.cjs" read wsPort)"
for p in "$quartz_port" "$ws_port"; do
  [[ -z "$p" ]] && continue
  leftover="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [[ -n "$leftover" ]]; then
    echo "[stop.sh $role] port $p still held by PID $leftover; killing"
    kill -9 "$leftover" 2>/dev/null || true
  fi
done

rm -f "$pid_file"
echo "[stop.sh $role] stopped"
