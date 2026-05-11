# Deployment

How `quartz_pty` runs in production.

## Stack shape

A "stack" is one quartz process talking to one bridge. They come in
two flavours, both running on the same machine, both isolated:

| role    | quartz HTTP | quartz WS | bridge port | bridge data dir              |
| ------- | ----------- | --------- | ----------- | ---------------------------- |
| prod    | 8080        | 3010      | 3000        | `claude_pty_prod/`           |
| staging | 8081        | 3011      | 3001        | `claude_pty_staging/`        |

Each side of the pair has its own data directory: separate inbox,
agent-memory, session registry, content tree. **Production runs
uninterrupted while staging is under test.** A bug in a staging
workflow cannot corrupt prod state.

## Layout on disk

```
<workspace>/
├── quartz_pty/                 # dev — your working tree
├── quartz_pty_prod/            # git worktree on quartz-pty-prod-worktree
│   ├── .quartz-pty-worktree.json
│   ├── content/                # clone of content repo (main branch)
│   ├── .pids/, .logs/
│   └── scripts/{run,stop,status}.sh
├── quartz_pty_staging/         # git worktree on quartz-pty-staging-worktree
│   └── content/                # clone of content repo (staging branch)
├── claude_pty_prod/            # bridge — see claude_pty repo
└── claude_pty_staging/
```

All five directories are siblings under the same workspace root.

The code repo (`quartz_pty/*`) uses **git worktrees**, so all three
trees share `.git/` and can be on different branches simultaneously.
The content repo (`content/*`) is **separately cloned** into each
worktree — content is its own git repo with no relationship to the
outer quartz_pty git.

## Operating

```bash
cd quartz_pty_prod    && bash scripts/run.sh prod      # start prod
cd quartz_pty_staging && bash scripts/run.sh staging   # start staging
bash quartz_pty/scripts/status.sh                      # check both
bash scripts/stop.sh prod                              # stop one
```

`run.sh`:

1. Reads `.quartz-pty-worktree.json` for the role's ports and bridge URL
2. Refuses if the worktree's pinned role doesn't match the argument
3. Refuses if the configured port is already held
4. Exports `WORKFLOW_BRIDGE_URL=http://127.0.0.1:<bridgePort>` so
   workflow subprocesses talk to the matching bridge
5. Spawns `npx quartz build --serve` detached, captures PID

## Promotion: staging → prod

Promotion is **`git checkout`**, not `npm run build && rsync`.

```bash
# Tag what's been validated in staging
git -C quartz_pty_staging tag -a prod-2026-05-11 -m "promoted from staging"
git -C quartz_pty_staging push origin prod-2026-05-11

# In prod, fast-forward to that tag
git -C quartz_pty_prod fetch --tags
git -C quartz_pty_prod merge --ff-only prod-2026-05-11
bash quartz_pty_prod/scripts/stop.sh prod
bash quartz_pty_prod/scripts/run.sh prod
```

There is no separate `dist/` to ship — `.ts` source runs directly. The
"prod build" is the same code that was tested in staging, byte for
byte.

Content promotion is a separate operation on the content repo (it's
its own git repo): typically a fast-forward merge of `staging` into
`main`, then re-clone or `git pull` inside `quartz_pty_prod/content/`.

## TypeScript deployment philosophy

- **Run source, not a build artifact.** Quartz's bundler handles the
  static-site emission; the *runtime* layer (workflow subprocess, dev
  server, CLI) loads `.ts` directly via the bundled loader. Same
  artifact in dev / staging / prod means a green staging proves prod.
- **`tsc --noEmit` is a gate, not a blocker.** `npm run check` enforces
  it in CI; production deploys never wait for type-check. If types
  drift, the gate goes red and the team fixes it — prod keeps serving.
- **Pin Node via `.nvmrc`** (currently `25`). A Node minor bump can
  change loader behaviour; staging and prod should never disagree on
  the runtime.

## What the bridge does

The bridge (`claude_pty`) is the long-running backend. It:

- Spawns and manages PTY sessions for CLI agents (Codex, Claude Code,
  Kimi, DeepSeek)
- Owns the inbox / ticket / workflow_task event log per session
- Serializes Quartz rebuilds (no agent runs its own `quartz build`)
- Holds write authority for content files; widgets and the sidebar
  call the bridge content API rather than touching disk directly

`quartz_pty` is the front-end and orchestration surface. It does not
hold any state the bridge doesn't already know about.

## Health checks

```bash
curl -fsS http://127.0.0.1:8080/                  # prod quartz
curl -fsS http://127.0.0.1:3000/api/health        # prod bridge
curl -fsS http://127.0.0.1:8081/                  # staging quartz
curl -fsS http://127.0.0.1:3001/api/health        # staging bridge
```

`scripts/status.sh` collapses all four into a one-line summary.
