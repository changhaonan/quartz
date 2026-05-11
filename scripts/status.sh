#!/usr/bin/env bash
# Print which prod/staging quartz instances are alive and which bridges
# they're paired with.

set -euo pipefail

worktree() {
  local role="$1"; local path="$2"
  if [[ ! -d "$path" ]]; then
    printf "%-9s  %-45s  %s\n" "$role" "$path" "(missing)"
    return
  fi
  local pid_file="$path/.pids/$role.pid"
  local cfg="$path/.quartz-pty-worktree.json"
  local quartz_port="" bridge_url=""
  if [[ -f "$cfg" ]]; then
    quartz_port="$(node -e "console.log((JSON.parse(require('fs').readFileSync('$cfg','utf8')).quartzPort)||'')" 2>/dev/null || true)"
    bridge_url="$(node -e "console.log((JSON.parse(require('fs').readFileSync('$cfg','utf8')).bridgeUrl)||'')" 2>/dev/null || true)"
  fi
  local pid="" status="not running"
  if [[ -f "$pid_file" ]]; then
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      status="alive (PID $pid)"
    else
      status="stale pidfile"
    fi
  fi
  local bridge_status=""
  if [[ -n "$bridge_url" ]]; then
    if curl -fsS -m 1 "$bridge_url/api/health" >/dev/null 2>&1; then
      bridge_status="✓"
    else
      bridge_status="✗"
    fi
  fi
  printf "%-9s  quartz :%-5s  bridge %s %s  %s\n" "$role" "$quartz_port" "$bridge_url" "$bridge_status" "$status"
}

# Derive the workspace root from this script's location, then look for
# sibling prod/staging worktrees. Layout is documented in DEPLOYMENT.md;
# overrides via QUARTZ_PTY_PROD_PATH / QUARTZ_PTY_STAGING_PATH env vars.
workspace_root="$(cd "$(dirname "$0")/../.." && pwd)"
prod_path="${QUARTZ_PTY_PROD_PATH:-$workspace_root/quartz_pty_prod}"
staging_path="${QUARTZ_PTY_STAGING_PATH:-$workspace_root/quartz_pty_staging}"

echo "quartz_pty stacks:"
worktree prod    "$prod_path"
worktree staging "$staging_path"
