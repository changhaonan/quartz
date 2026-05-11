#!/usr/bin/env bash
# One-click promote a quartz_pty stack to the current v4 HEAD.
#
# Usage:
#   scripts/promote.sh staging
#   scripts/promote.sh prod
#
# What it does (in order):
#   1. Refuses if not invoked from the dev tree (avoids "promote prod
#      from inside prod" foot-gun).
#   2. Stops the target stack's quartz process via its own stop.sh.
#   3. Fast-forward-merges v4 into the target worktree's branch.
#      Bails on any merge conflict — promotion is supposed to be
#      always-forward, never lossy.
#   4. Restarts the target stack via its own run.sh.
#   5. Polls HTTP health on the target's quartz + bridge for up to 30s.
#   6. Reports the deployed commit and reachability.

set -euo pipefail

dev_root="$(cd "$(dirname "$0")/.." && pwd)"

role="${1:-}"
if [[ "$role" != "prod" && "$role" != "staging" ]]; then
  echo "usage: $0 {prod|staging}" >&2
  exit 2
fi

# Promote runs from the dev tree (quartz_pty/) because that's where v4
# is checked out. The target worktree's branch must be different.
dev_role="$(node "$dev_root/scripts/_worktree-config.cjs" read role 2>/dev/null || true)"
if [[ -n "$dev_role" ]]; then
  echo "Refusing to run promote.sh from the $dev_role worktree." >&2
  echo "Run it from the dev tree ($dev_root should NOT have a role)." >&2
  exit 1
fi

# Target worktree path is a sibling, by naming convention.
target_root="$(cd "$dev_root/.." && pwd)/quartz_pty_$role"
if [[ ! -d "$target_root" ]]; then
  echo "Target worktree not found: $target_root" >&2
  exit 1
fi
if [[ ! -f "$target_root/.quartz-pty-worktree.json" ]]; then
  echo "$target_root is not a role-pinned worktree (no .quartz-pty-worktree.json)." >&2
  exit 1
fi

# Snapshot the v4 HEAD we're promoting (for reporting + git tag idea).
v4_head="$(git -C "$dev_root" rev-parse v4)"
target_head_before="$(git -C "$target_root" rev-parse HEAD)"

echo "[promote] $role: $target_head_before → $v4_head"

# Step 2: stop
echo "[promote] stopping $role..."
bash "$target_root/scripts/stop.sh" "$role" >/dev/null 2>&1 || true

# Step 3: ff-merge
echo "[promote] fast-forward merging v4 into $role worktree..."
if ! git -C "$target_root" merge --ff-only v4 >/tmp/promote-merge.log 2>&1; then
  echo "[promote] merge FAILED — bailing without restart. log:" >&2
  cat /tmp/promote-merge.log >&2
  echo >&2
  echo "[promote] $role is stopped and on $target_head_before; investigate before re-running." >&2
  exit 1
fi
target_head_after="$(git -C "$target_root" rev-parse HEAD)"

# Step 4: restart
echo "[promote] restarting $role..."
bash "$target_root/scripts/run.sh" "$role"

# Step 5: health check (poll up to 30s)
quartz_port="$(node "$target_root/scripts/_worktree-config.cjs" read quartzPort)"
bridge_url="$(node "$target_root/scripts/_worktree-config.cjs" read bridgeUrl)"

echo "[promote] waiting for quartz :$quartz_port and bridge $bridge_url..."
deadline=$((SECONDS + 30))
quartz_ok=0
bridge_ok=0
while [[ $SECONDS -lt $deadline ]]; do
  if [[ $quartz_ok -eq 0 ]]; then
    if curl -fsS -m 2 "http://127.0.0.1:$quartz_port/" -o /dev/null 2>/dev/null; then
      quartz_ok=1
      echo "[promote]   quartz :$quartz_port up"
    fi
  fi
  if [[ $bridge_ok -eq 0 ]]; then
    if curl -fsS -m 2 "$bridge_url/api/health" -o /dev/null 2>/dev/null; then
      bridge_ok=1
      echo "[promote]   bridge $bridge_url up"
    fi
  fi
  [[ $quartz_ok -eq 1 && $bridge_ok -eq 1 ]] && break
  sleep 1
done

if [[ $quartz_ok -eq 0 ]]; then
  echo "[promote] FAIL: quartz :$quartz_port unreachable after 30s." >&2
  exit 1
fi
if [[ $bridge_ok -eq 0 ]]; then
  echo "[promote] WARN: bridge $bridge_url not reachable — quartz will load, but workflow runs will fail until you start the matching bridge." >&2
fi

echo "[promote] OK — $role at $target_head_after"
