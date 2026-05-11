# quartz_pty

A fork of [Quartz v4](https://quartz.jzhao.xyz/) that turns a digital
garden into a workspace for **multi-agent workflows**. Markdown pages
embed a visual workflow widget; runs are dispatched through a separate
PTY bridge ([`claude_pty`](https://github.com/changhaonan/claude_pty))
to real CLI agents (Codex, Claude Code, Kimi).

Built on Quartz v4 — the static-site generator, content pipeline,
Explorer / Graph / TOC / Backlinks shell, and SCSS layer are all
upstream. Everything under `quartz/widgets/workflow/` and
`scripts/workflow-runtime/` is new.

## What's new vs upstream Quartz

- **Workflow widget** (`quartz/widgets/workflow/`) — visual node graph
  embedded in a markdown page via a fenced `widget` block. Nodes are
  primitives (input, fileTicket, invokeAgent, ask, telephone, refine
  loops, …); edges are typed data flow. The widget codegens a runnable
  TypeScript subprocess on demand.
- **Workflow runtime** (`quartz/widgets/workflow/runtime/`) — the
  Director-side library the codegen'd subprocess imports. Each
  `invokeAgent` call hands one task to a live agent session via the
  bridge's inbox API; the agent acks via HTTP when done. No screen
  scraping, no file-mtime sentinels — control flow is API-driven.
- **Bridge transformer** (`quartz/plugins/transformers/bridgeFrame.ts`)
  — renders embedded bridge surfaces (illustration boards, blueprint
  boards, live session frames) inline in Quartz pages.
- **AI sidebar** (`quartz/components/AiSidebar.tsx`) — a per-page
  conversation surface backed by the bridge.

## Repo layout

```
quartz_pty/                  # this code repo (outer)
├── quartz/                  # forked Quartz v4 — core + new widgets
├── scripts/workflow-runtime # mock bridge, agent simulator, 63 mock tests
├── scripts/{run,stop,status}.sh
└── content/                 # an independent git repo (gitignored here)
```

The outer repo is **code-only**. The `content/` directory is its own
independent git repo so notes / boards / workflows can be versioned
separately from the code that renders them.

## Prod / staging stacks

Two worktrees sit alongside this one:

- `/Users/haonanchang/Projects/quartz_pty_prod`   — quartz :8080 → bridge :3000
- `/Users/haonanchang/Projects/quartz_pty_staging` — quartz :8081 → bridge :3001

Each worktree has its own `content/` clone and a
`.quartz-pty-worktree.json` pinning role and ports. The bridges
(`claude_pty_prod`, `claude_pty_staging`) live in sibling directories
and maintain isolated session / inbox / agent-memory state.

Start a stack:

```bash
cd quartz_pty_prod && bash scripts/run.sh prod
cd quartz_pty_staging && bash scripts/run.sh staging
bash quartz_pty/scripts/status.sh
```

The launcher exports `WORKFLOW_BRIDGE_URL` so the workflow subprocess
talks to the matching bridge. It refuses to start the wrong role from
the wrong worktree, or against an occupied port.

## Local dev

```bash
nvm use                  # honours .nvmrc (Node 25)
npm ci
npm run quartz -- build --serve   # default :8080, talks to bridge :3210
npm run check            # tsc --noEmit + prettier
npm run test:runtime     # 63 mock-bridge tests
```

The default dev bridge URL is `http://127.0.0.1:3210`; override with
`WORKFLOW_BRIDGE_URL=http://...` if you point at a different bridge.

## Further reading

- [`PHILOSOPHY.md`](./PHILOSOPHY.md) — the design rules this fork is
  built around: code/content separation, API-driven control,
  files-own-runtime, single rebuilder, run-source-not-builds.
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — operational docs: prod/staging
  worktree layout, promotion path, port map, health checks.

## Acknowledgements

Quartz v4 by [@jackyzha0](https://github.com/jackyzha0) and contributors —
the publishing-stack-as-a-library that this fork builds on. Upstream
docs: <https://quartz.jzhao.xyz/>. Upstream license: MIT (see
`LICENSE.txt`).
