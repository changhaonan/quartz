---
name: restart-all
description: One-shot restart of the whole quartz_pty + claude_pty stack — all 3 quartz dev-servers and all 3 bridges, each from the correct worktree, with verification. Use when the user says "restart everything", "重启全部/所有", "restart the stack", "一键重启", or wants prod+staging+dev brought back up together.
allowed-tools: Bash
---

# Restart-all (whole stack)

Restarts every quartz dev-server and every bridge, each from its own
worktree, in dependency order, then verifies and prints a status table.

## The command

```bash
bash scripts/restart-all.sh
```

One command, no args. It restarts all 6 components:

| # | component | worktree | port |
|---|-----------|----------|------|
| 1 | prod bridge    | `claude_pty_prod`    | :3000 |
| 2 | staging bridge | `claude_pty_staging` | :3001 |
| 3 | dev bridge     | `claude_pty`         | :3210 |
| 4 | prod quartz    | `quartz_pty_prod`    | :8080 |
| 5 | staging quartz | `quartz_pty_staging` | :8081 |
| 6 | dev quartz     | `quartz_pty`         | :8090 |

Bridges go first — quartz `run.sh` health-checks its bridge on start.
Each bridge starts from its OWN worktree, so a stray rollback checkout
can't end up serving :3000 (that bug → CORS preflight 404 → "PTY start
failed: Failed to fetch").

## Verification it does for you

- quartz → polls `/` for HTTP 200
- bridges → `/api/health` responds AND the CORS preflight on
  `OPTIONS /api/sessions` returns `access-control-allow-origin`. The
  CORS check is the important one: a bridge can answer `/api/health`
  fine while still failing PTY start because it's the wrong checkout.
  The status table also prints the git branch each bridge is serving.

Exits non-zero and prints `✗` if any component fails to come up.

## Authorization

restart-all touches prod and staging — the Claude Code auto-mode
classifier WILL block `bash scripts/restart-all.sh` unless the user has
explicitly authorized in this turn. Pattern:

1. Propose: "Want me to run `restart-all`? ~10s downtime on each stack."
2. Wait for the user to reply 授权 / authorize / yes / OK.
3. Then run it.

If the classifier still blocks it after authorization, tell the user to
run it themselves: type `! bash scripts/restart-all.sh` in the prompt —
that runs in-session and the output lands in the conversation.

Restarting the prod/staging bridges kills any live PTY/agent sessions on
them. If a session might have in-flight work, say so before running.

## When NOT to use

- **Single stack only** → use that worktree's `scripts/run.sh` instead.
- **Deploying new code** → use the `deploy` skill (promote = stop +
  ff-merge v4 + restart). `restart-all` only bounces what's already
  checked out; it does not move any branch.

## Reference

- `scripts/restart-all.sh` — the implementation
- `DEPLOYMENT.md` — port map and per-worktree layout
