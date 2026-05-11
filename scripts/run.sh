#!/usr/bin/env bash
# Start the quartz dev server for this worktree's pinned role.
#
# Usage:
#   scripts/run.sh prod      # uses worktree config (quartzPort, bridgePort)
#   scripts/run.sh staging
#
# The role must match `.quartz-pty-worktree.json`. The script refuses to
# start prod from the staging worktree (and vice versa) so you don't
# accidentally point the prod port at the staging content tree.
#
# What it does:
#   1. Reads role/ports from .quartz-pty-worktree.json
#   2. Refuses on role mismatch or occupied port
#   3. Exports WORKFLOW_BRIDGE_URL=http://127.0.0.1:<bridgePort> so the
#      workflow runtime (and any spawned child) talks to the matching bridge
#   4. Spawns `npx quartz build --serve --port <P> --wsPort <W>` detached,
#      writes pid → .pids/<role>.pid, log → .logs/<role>.log

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
. "$repo_root/scripts/_lib.sh"

role="${1:-}"
if [[ "$role" != "prod" && "$role" != "staging" ]]; then
  echo "usage: $0 {prod|staging}" >&2
  exit 2
fi

worktree_cfg="node $repo_root/scripts/_worktree-config.cjs"
configured_role="$($worktree_cfg read role 2>/dev/null || true)"
if [[ -z "$configured_role" ]]; then
  echo "No .quartz-pty-worktree.json at $repo_root — this isn't a role-pinned worktree." >&2
  echo "Run from a quartz_pty_{prod,staging} worktree (see DEPLOYMENT.md)." >&2
  exit 1
fi
if [[ "$configured_role" != "$role" ]]; then
  echo "This worktree is pinned to role '$configured_role'; refusing to start '$role' here." >&2
  echo "Use the matching worktree, or edit .quartz-pty-worktree.json if this tree is meant to be shared." >&2
  exit 1
fi

quartz_port="$($worktree_cfg read quartzPort)"
ws_port="$($worktree_cfg read wsPort)"
bridge_port="$($worktree_cfg read bridgePort)"
bridge_url="$($worktree_cfg read bridgeUrl)"

[[ -z "$quartz_port" || -z "$ws_port" || -z "$bridge_port" || -z "$bridge_url" ]] && {
  echo "worktree config missing required fields (quartzPort/wsPort/bridgePort/bridgeUrl)" >&2
  exit 1
}

pid_dir="$repo_root/.pids"
log_dir="$repo_root/.logs"
mkdir -p "$pid_dir" "$log_dir"
pid_file="$pid_dir/$role.pid"
log_file="$log_dir/$role.log"

if [[ -f "$pid_file" ]]; then
  existing="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -n "$existing" ]] && kill -0 "$existing" 2>/dev/null; then
    echo "$role already running (PID $existing). Use scripts/stop.sh $role first." >&2
    exit 1
  fi
  rm -f "$pid_file"
fi

for p in "$quartz_port" "$ws_port"; do
  occupied_pid="$(listener_pid_on_port "$p" || true)"
  if [[ -n "$occupied_pid" ]]; then
    echo "Port $p is occupied by PID $occupied_pid. Free it before starting $role." >&2
    exit 1
  fi
done

# Preflight: confirm the matching bridge is reachable. Without this, quartz
# starts fine but every workflow run dies on the first bridge call — better
# to fail loudly here.
if ! curl -fsS -m 2 "$bridge_url/api/health" >/dev/null 2>&1; then
  echo "warn: bridge at $bridge_url is not reachable. Quartz will start but" >&2
  echo "      workflow runs will fail until the matching bridge is up." >&2
  echo "      Start it from the matching claude_pty_$role worktree." >&2
fi

echo "[run.sh $role] quartz on :$quartz_port (ws :$ws_port) → bridge $bridge_url"
echo "[run.sh $role] log → $log_file"

# Spawn detached. nohup + & so the dev-server keeps running after this
# script returns. setsid would be cleaner but isn't installed on macOS by
# default; nohup is enough since we capture the PID and the dev-server
# doesn't re-exec.
cd "$repo_root"
nohup env \
  WORKFLOW_BRIDGE_URL="$bridge_url" \
  QUARTZ_PTY_ROLE="$role" \
  npx quartz build --serve --port "$quartz_port" --wsPort "$ws_port" \
  >> "$log_file" 2>&1 &
pid="$!"
disown "$pid" 2>/dev/null || true

if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
  echo "failed to spawn quartz dev server" >&2
  exit 1
fi

echo "$pid" > "$pid_file"
echo "[run.sh $role] started, PID $pid"
