# quartz_pty Milestones

## Today: fork and prove the shell

### M1: Fork seed

Status: done

- Create `/Users/haonanchang/Projects/quartz_pty` from Quartz v4.
- Carry over the validated probe changes.
- Keep this fork separate from `claude_pty`.

Proof:

- `npm ci`
- `npm run quartz -- build`

### M2: Knowledge workbench baseline

Status: done

- Global wide desktop layout.
- Keep Explorer, Graph, TOC, and Backlinks as the default shell.
- Add `BridgeFrame` fenced block transformer.
- Render embedded bridge surfaces inside Quartz pages.

Pages:

- `/boards/illustration-board`
- `/boards/blueprint-board`
- `/sessions/live-session-frame`

### M3: File-scoped runtime model

Status: done

- Add a real file-scoped workspace sample under `content/work/`.
- The workspace file owns its sibling folder.
- Runtime blocks declare session, board, and blueprint widgets.
- Artifacts are written under the workspace folder.

Target shape:

```text
content/work/quartz-file-runtime-probe.md
content/work/quartz-file-runtime-probe.runtime/
  board.json
  session.json
  blueprint.json
  runs/
  evidence/
  traces/
```

Note: the `.runtime` suffix avoids a Quartz routing collision between
`foo.md` and a same-named `foo/` content folder.

### M4: AI sidebar design stub

Status: done

- Add an AI workspace panel as its own page-level region, separate from the
  Quartz Graph/TOC/Backlinks sidebar.
- Desktop panel target: about one third of the viewport, with sticky full-height
  behavior.
- First version is locally interactive but non-mutating.
- It explains active file context and planned actions.
- Later versions create files, add runtime blocks, and trigger bridge actions.

Proof:

- `quartz/components/AiSidebar.tsx`
- `quartz/components/renderPage.tsx` renders `.assistant-panel` outside the
  normal `.right.sidebar`.
- Browser proof shows `.assistant-panel` at 34% viewport width on a 1600px
  desktop viewport.

### M5: Real bridge integration

Status: done

- Point session iframe at a real bridge port, not Vite.
- Make `/bridge/session`, `/bridge/illustration`, and `/bridge/blueprint` real bridge routes.
- Enforce read-only in bridge backend/API.
- Add typed bridge API client.
- Read file-scoped runtime manifests from the bridge.

Current proof:

- `claude_pty` frontend has bridge embed aliases.
- Quartz pages point at `http://127.0.0.1:3210/bridge/...`.
- `readonly=1` disables or hides mutating frontend controls.
- `X-Bridge-Embed-Readonly: 1` rejects mutating `/api` calls.
- Read-only WebSocket clients can attach without bootstrapping a PTY and cannot
  send `input`.
- AI sidebar reads `/api/health` and `/api/file-runtime/manifest`.

### M6: Write coordination and rebuild service

Status: in progress

- Add a bridge-backed AI workspace PTY region before write coordination:
  - `Start PTY` creates a real bridge session through `POST /api/sessions`.
  - The page embeds `/bridge/session?session=<id>` as an Xterm display.
  - The sidebar composer sends prompts through `POST /api/sessions/:id/input`.
  - The AI workspace is a global shell host, not a per-page disposable widget:
    SPA navigation preserves the existing panel DOM, PTY iframe, and session id,
    then syncs only the current page's file context.
  - Client switching is part of the global workspace:
    Codex, Claude, Kimi, and DeepSeek can be selected from the shell; switching
    clients forces a new file-runtime PTY session and updates the workspace's
    active session.
  - Quartz workspace sessions bind `quartz_workspace_operator` and receive a
    startup workspace context block after role handshake.
  - `POST /api/file-runtime/session` resumes an existing live `sessionId` from
    the workspace `session.json`, or creates one and writes it back.
  - Local CORS is limited to health, manifest, workspace session create/resume,
    session read, and session input.

- Add a logical long-running workspace service registry:
  - Each page workspace can persist `.runtime/workspace.json`.
  - `GET /api/file-runtime/workspaces` lists registered workspaces.
  - `POST /api/file-runtime/workspaces` registers or refreshes a workspace.
  - `GET /api/file-runtime/workspaces/:workspaceId` reads one workspace.
  - `/api/file-runtime/session` updates the owning workspace's
    `activeSessionId` when it creates or resumes a PTY.

- Add the bridge-owned rebuild queue skeleton:
  - `POST /api/file-runtime/workspaces/:workspaceId/rebuild` queues a Quartz
    rebuild request.
  - `GET /api/file-runtime/rebuild` exposes queued, active, and last build
    status.
  - The bridge runs at most one `npm run quartz -- build` at a time.

- Add a single bridge-owned content write API; sidebar and agents must not write
  workspace Markdown directly.
- Add per-workspace locks and optimistic version checks for `.md` frontmatter,
  runtime blocks, and generated sections.
- Use atomic writes for rewritten files: write temp file, fsync where practical,
  then rename.
- Keep `.runtime/runs`, `.runtime/traces`, and `.runtime/evidence` append-only
  where possible to avoid multi-writer overwrites.
- Add a single rebuild worker for Quartz output. No agent or widget should run
  its own concurrent `quartz build`.
- Queue rebuild requests, debounce bursts, and run at most one rebuild at a
  time.
- Build into a temporary output directory, then atomically publish/swap after a
  successful build so a failed build keeps serving the previous site.
- Expose build status through bridge APIs so the sidebar can show queued,
  building, failed, and published states.

Long-running service rule:

- Opening a page should not run an ad hoc rebuild. The bridge-owned service
  watches/queues file changes, rebuilds Quartz serially, and lets pages reconnect
  to their file-scoped sessions from `.runtime/session.json`.

Concurrency rule:

```text
all writers -> bridge file-runtime API -> content lock/version check
            -> build queue -> single builder -> atomic publish
```

### M7: File operations through AI sidebar

Status: next

- Add write-capable file-runtime APIs behind explicit non-read-only calls.
- Let the sidebar create workspace files and sibling `.runtime` folders.
- Let the sidebar append run summaries under `runs/`.
- Keep destructive runtime actions routed through bridge permission checks.

## Hard rules

- Quartz owns shell, graph, search, backlinks, and file navigation.
- `claude_pty` owns runtime authority and dangerous mutations.
- Files declare runtime workspaces.
- Artifacts write into the owning file's folder.
- Rebuilds are serialized by one bridge-owned builder.
- Sidebar assists file operations; it is not the source of truth.
