---
name: deploy
description: Promote a quartz_pty stack (staging or prod) to v4 HEAD and verify with e2e. Use this whenever the user says "deploy", "promote", "ship", "update prod", "上 prod", or asks for any change to land on a non-dev environment.
allowed-tools: Bash, Read
---

# Deploy (promote + verify)

## When to use

- User says deploy / promote / ship / update prod / 上 prod / 上 staging
- Any commit on v4 needs to land on staging or prod
- Sanity-check after a bridge code change (claude_pty side) by
  redeploying the quartz side

If the change is in dev only (working tree of `quartz_pty/`) and the
user hasn't asked to promote, do NOT deploy. Wait for them to ask.

## The flow

One command per role. Use the npm scripts — they wrap `scripts/promote.sh`
which does stop → ff-merge v4 → restart → health check.

```bash
npm run promote:staging   # ff staging from v4, restart, health check
npm run promote:prod      # same for prod
```

Then verify with e2e:

```bash
npm run test:e2e          # against staging (default)
npm run test:e2e:prod     # against prod
```

`test:e2e` proves the sidebar-PTY-resume path. It does **not** prove
arbitrary other UI behavior — for that, write a new e2e (see the
`e2e-ui-test` skill) and add it to the test:e2e chain.

## Required authorization

Promote commands modify a non-dev environment. The Claude Code auto-mode
classifier WILL block `bash scripts/promote.sh prod` unless the user
has explicitly authorized in this turn. The pattern:

1. Propose: "Want me to `npm run promote:prod`? It'll be ~10s downtime."
2. Wait for the user to reply 授权 / authorize / yes / OK.
3. Then run it.

Even if you're confident, don't pre-emptively run prod promotions —
unauthorized prod deploys get denied AND lose the user's trust.

`promote:staging` is lower-risk; you can usually just run it after
saying "I'll promote staging first to verify."

## What promote.sh does internally

Useful to know when things go sideways:

1. Refuses if invoked from a role-pinned worktree (would corrupt that
   worktree's branch). MUST run from the dev tree.
2. Calls `<target>/scripts/stop.sh <role>` — graceful SIGTERM then
   SIGKILL fallback, frees the ports.
3. `git -C <target> merge --ff-only v4`. If the target branch has
   diverged from v4, this fails. promote.sh bails WITHOUT restarting,
   leaving the stack stopped on the prior commit. Investigate (likely
   someone made commits on the role's branch directly — they
   shouldn't have).
4. `<target>/scripts/run.sh <role>` to restart.
5. Polls quartz HTTP and bridge `/api/health` for up to 30s. Quartz
   timeout = fail; bridge timeout = warn (quartz will run, workflows
   won't).

## Failure modes you might hit

- **Merge conflict** ("Not a fast-forward"): someone committed on the
  role's branch. Either drop those commits (`git -C <target> reset
  --hard v4` — destructive, ask first) or merge them back into v4
  first. promote.sh will not silently force a non-ff merge.

- **Port held** after restart: rare; usually the old PID didn't fully
  exit. `lsof -nP -iTCP:<port> -sTCP:LISTEN` to find it, kill, retry.

- **Bridge unreachable warning**: the matching `claude_pty_<role>`
  bridge isn't running. Start it from its own scripts/run.sh; quartz
  will then talk to it without restart.

- **e2e fails after promote**: the deployed bundle has a bug, the
  health check passed (server is up) but behavior is wrong. Revert
  with: stop, `git -C <target> reset --hard <prev-commit>`, restart.
  Or: fix on v4, re-promote.

## After deploying prod

Tag the v4 commit so future "what's on prod right now" questions are
trivially answerable:

```bash
git tag -a prod-$(date +%Y%m%d) -m "promoted to prod"
git push origin prod-$(date +%Y%m%d)   # if the auto-push doesn't pick it up
```

(Not strictly required — `git -C ~/Projects/quartz_pty_prod log -1`
also tells you. But tags survive worktree state changes.)

## Reference

- `scripts/promote.sh` — the implementation
- `scripts/test-sidebar-resume.mjs` — the current e2e
- `DEPLOYMENT.md` — the operational doc (port map, layout, health checks)
