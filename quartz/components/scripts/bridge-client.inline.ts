import { getBlockWidgetRuntime, BlockWidget, WidgetCtx } from "./block-widget-runtime.inline"
// Side-effect import: registers nav/click handlers for .block-card
// toolbars on pages that opt in via frontmatter `blocks: true`.
import "./block-toolbar.inline"
import "./pdf-viewer.inline"

type BridgeHealth = {
  ok?: boolean
  port?: number
  sessionCount?: number
  agents?: Record<
    string,
    {
      installed?: boolean
      enabled?: boolean
      available?: boolean
      version?: string
      path?: string
    }
  >
  version?: {
    label?: string
    packageVersion?: string
    gitCommit?: string
    dirty?: boolean
  }
}

type BridgeStatus = "probing" | "connected" | "missing" | "error"

type FileRuntimeManifest = {
  ok?: boolean
  exists?: boolean
  artifacts?: {
    board?: unknown | null
    session?: unknown | null
    blueprint?: unknown | null
    workspace?: unknown | null
  }
  folders?: {
    runs?: unknown[]
    evidence?: unknown[]
    traces?: unknown[]
  }
}

type BridgeSessionPayload = {
  ok?: boolean
  resumed?: boolean
  session?: {
    id?: string
    sessionId?: string
    role?: {
      id?: string
      label?: string
    }
    runtime?: {
      cwd?: string
      agentPath?: string
    }
  }
  error?: string
}

type BridgeSessionStatePayload = {
  ok?: boolean
  session?: {
    inited?: boolean
    state?: string
    currentState?: string
    facts?: {
      lastState?: string
    }
  }
}

function setSidebarStatus(
  sidebar: HTMLElement,
  status: BridgeStatus,
  label: string,
  meta: string,
  bridgeOrigin: string | null,
) {
  const panel = sidebar.querySelector<HTMLElement>(".ai-sidebar__bridge")
  const statusEl = sidebar.querySelector<HTMLElement>(".ai-sidebar__bridge-status")
  const metaEl = sidebar.querySelector<HTMLElement>(".ai-sidebar__bridge-meta")
  const linkEl = sidebar.querySelector<HTMLAnchorElement>(".ai-sidebar__bridge-link")

  panel?.setAttribute("data-bridge-status", status)
  if (statusEl) statusEl.textContent = label
  if (metaEl) metaEl.textContent = meta
  if (linkEl) {
    if (bridgeOrigin) {
      linkEl.href = bridgeOrigin
      linkEl.removeAttribute("aria-disabled")
    } else {
      linkEl.href = "#"
      linkEl.setAttribute("aria-disabled", "true")
    }
  }
}

function setRuntimeMeta(sidebar: HTMLElement, text: string) {
  const runtimeEl = sidebar.querySelector<HTMLElement>(".ai-sidebar__runtime-meta")
  if (runtimeEl) runtimeEl.textContent = text
}

function setAiStatus(sidebar: HTMLElement, text: string) {
  const status = sidebar.querySelector<HTMLElement>("[data-ai-status]")
  if (status) status.textContent = text
}

function setTerminalStatus(sidebar: HTMLElement, text: string) {
  const terminal = sidebar.querySelector<HTMLElement>("[data-ai-terminal]")
  if (!terminal) return
  terminal.replaceChildren()
  const placeholder = document.createElement("span")
  placeholder.textContent = text
  terminal.appendChild(placeholder)
}

const aiContextAttrs = [
  "data-file-slug",
  "data-workspace-id",
  "data-state-dir",
  "data-role-id",
  "data-agent",
  "data-cwd",
  "data-model",
  "data-difficulty",
  "data-bridge-origin",
]

type AiContext = Record<string, string>
type AiWindow = Window & { __quartzAiPendingContext?: AiContext }
const GLOBAL_AI_WORKSPACE_ID = "quartz-site"
const DEFAULT_AI_AGENT = "codex"
const DEFAULT_CODEX_MODEL = "gpt-5.4-mini"
const DEFAULT_AI_DIFFICULTY = "medium"

function defaultModelForAgent(agent: string): string {
  return agent === DEFAULT_AI_AGENT ? DEFAULT_CODEX_MODEL : ""
}

function applySidebarDefaults(sidebar: HTMLElement) {
  const agent = sidebar.dataset.agent || DEFAULT_AI_AGENT
  sidebar.dataset.agent = agent
  if (!sidebar.dataset.difficulty) sidebar.dataset.difficulty = DEFAULT_AI_DIFFICULTY
  if (!sidebar.dataset.model) {
    const defaultModel = defaultModelForAgent(agent)
    if (defaultModel) sidebar.dataset.model = defaultModel
  }
}

function readAiContext(from: HTMLElement | null): AiContext {
  const context: AiContext = {}
  if (!from) return context
  for (const attr of aiContextAttrs) {
    const value = from.getAttribute(attr)
    if (value !== null) context[attr] = value
  }
  return context
}

function applyAiContext(to: HTMLElement, context: AiContext) {
  const previousBinding = currentSessionBinding(to)
  const keepSelectedAgent = to.dataset.agentLocked === "1"
  for (const attr of aiContextAttrs) {
    if (attr === "data-agent" && keepSelectedAgent) continue
    const value = context[attr]
    if (value === undefined) to.removeAttribute(attr)
    else to.setAttribute(attr, value)
  }
  applySidebarDefaults(to)
  clearMismatchedSessionBinding(to, previousBinding)
}

function renderSidebarContextFacts(sidebar: HTMLElement) {
  const workspace = sidebar.querySelector<HTMLElement>('[data-ai-fact="workspace"]')
  const role = sidebar.querySelector<HTMLElement>('[data-ai-fact="role"]')
  const state = sidebar.querySelector<HTMLElement>('[data-ai-fact="state"]')
  if (workspace) workspace.textContent = resolveWorkspaceId(sidebar)
  if (role) role.textContent = sidebar.dataset.roleId || "none"
  if (state) state.textContent = sidebar.dataset.stateDir || "not declared"
}

function syncClientSelector(sidebar: HTMLElement) {
  const select = sidebar.querySelector<HTMLSelectElement>("[data-ai-client-select]")
  if (!select) return
  select.value = sidebar.dataset.agent || DEFAULT_AI_AGENT
}

function applyAgentAvailability(sidebar: HTMLElement, agents: BridgeHealth["agents"]) {
  const select = sidebar.querySelector<HTMLSelectElement>("[data-ai-client-select]")
  if (!select) return
  for (const option of Array.from(select.options)) {
    const agent = option.value
    if (agent === "coze") {
      option.disabled = true
      option.textContent = "Coze (not wired)"
      continue
    }
    const status = agents?.[agent]
    const available = Boolean(status?.available)
    option.disabled = !available
    const label = option.dataset.label || option.textContent || agent
    option.dataset.label = label.replace(/\s+\(.+\)$/, "")
    option.textContent = available
      ? option.dataset.label
      : `${option.dataset.label} (${status?.installed === false ? "missing" : "disabled"})`
  }
}

function ensureGlobalAiHost(): HTMLElement | null {
  const panels = Array.from(document.querySelectorAll<HTMLElement>(".assistant-panel"))
  if (!panels.length) return null

  const host = panels.find((panel) => "aiGlobalHost" in panel.dataset) ?? panels[0]
  host.dataset.aiGlobalHost = ""
  host.dataset.persist = ""

  const hostSidebar = host.querySelector<HTMLElement>(".ai-sidebar")
  if (!hostSidebar) return null

  for (const panel of panels) {
    if (panel === host) continue
    const templateSidebar = panel.querySelector<HTMLElement>(".ai-sidebar")
    if (templateSidebar) applyAiContext(hostSidebar, readAiContext(templateSidebar))
    panel.remove()
  }

  const pendingContext = (window as AiWindow).__quartzAiPendingContext
  if (pendingContext) {
    applyAiContext(hostSidebar, pendingContext)
    delete (window as AiWindow).__quartzAiPendingContext
  }

  applySidebarDefaults(hostSidebar)
  renderSidebarContextFacts(hostSidebar)
  syncClientSelector(hostSidebar)
  return hostSidebar
}

// Persisted session id per site-level AI workspace so SPA navigation,
// rebuilds, and refreshes reconnect to the same document-operator PTY.
// Page/file runtime ids are injected as context, not used as session
// identity, otherwise ordinary page navigation creates page-scoped PTYs.
function resolveWorkspaceId(sidebar: HTMLElement): string {
  return sidebar.dataset.aiWorkspaceId || GLOBAL_AI_WORKSPACE_ID
}

function currentSessionBinding(
  sidebar: HTMLElement,
  bridgeOrigin = findBridgeOrigin(sidebar) || "",
): string {
  return JSON.stringify([
    bridgeOrigin,
    resolveWorkspaceId(sidebar),
    sidebar.dataset.roleId || "",
    sidebar.dataset.agent || DEFAULT_AI_AGENT,
    sidebar.dataset.cwd || "",
    sidebar.dataset.model || defaultModelForAgent(sidebar.dataset.agent || DEFAULT_AI_AGENT),
    sidebar.dataset.difficulty || DEFAULT_AI_DIFFICULTY,
  ])
}

// Binding that determines when we should (re-)inject the workspace
// primer into the PTY. Intentionally workspace-scoped only — fileSlug
// and stateDir used to be part of this, which caused a re-injection on
// every page navigation. The agent only needs the workspace primer
// once per session; if the user wants the agent to read a specific
// page, they ask, and the agent can `cat content/X.md` directly.
function currentPageContextBinding(sidebar: HTMLElement): string {
  return JSON.stringify([
    resolveWorkspaceId(sidebar),
    sidebar.dataset.roleId || "",
    sidebar.dataset.agent || DEFAULT_AI_AGENT,
    sidebar.dataset.cwd || "",
    sidebar.dataset.model || defaultModelForAgent(sidebar.dataset.agent || DEFAULT_AI_AGENT),
  ])
}

function rememberSessionBinding(sidebar: HTMLElement, bridgeOrigin: string, sessionId: string) {
  sidebar.dataset.sessionId = sessionId
  sidebar.dataset.sessionBinding = currentSessionBinding(sidebar, bridgeOrigin)
}

function clearSidebarSession(sidebar: HTMLElement, reason: string) {
  delete sidebar.dataset.sessionId
  delete sidebar.dataset.sessionBinding
  delete sidebar.dataset.workspaceContextSent
  setTerminalStatus(sidebar, reason)
}

function clearMismatchedSessionBinding(sidebar: HTMLElement, previousBinding = "") {
  if (!sidebar.dataset.sessionId) return
  const expectedBinding = currentSessionBinding(sidebar)
  const actualBinding = sidebar.dataset.sessionBinding || previousBinding
  if (actualBinding && actualBinding === expectedBinding) return
  clearSidebarSession(
    sidebar,
    "PTY session changes with this workspace. Start or resume the workspace PTY.",
  )
}

function activeSessionMatchesContext(sidebar: HTMLElement, bridgeOrigin: string): boolean {
  const expectedBinding = currentSessionBinding(sidebar, bridgeOrigin)
  if (!sidebar.dataset.sessionId) return false
  if (!sidebar.dataset.sessionBinding) {
    sidebar.dataset.sessionBinding = expectedBinding
    return true
  }
  return sidebar.dataset.sessionBinding === expectedBinding
}

function sessionStorageKey(bridgeOrigin: string, workspaceId: string): string {
  return `quartz-pty:session:${bridgeOrigin}:${workspaceId}`
}

function loadStoredSessionId(bridgeOrigin: string, workspaceId: string): string | null {
  if (!workspaceId) return null
  try {
    return window.localStorage.getItem(sessionStorageKey(bridgeOrigin, workspaceId))
  } catch {
    return null
  }
}

function storeSessionId(bridgeOrigin: string, workspaceId: string, sessionId: string) {
  if (!workspaceId) return
  try {
    window.localStorage.setItem(sessionStorageKey(bridgeOrigin, workspaceId), sessionId)
  } catch {}
}

function clearStoredSessionId(bridgeOrigin: string, workspaceId: string) {
  if (!workspaceId) return
  try {
    window.localStorage.removeItem(sessionStorageKey(bridgeOrigin, workspaceId))
  } catch {}
}

function mountTerminalFrame(sidebar: HTMLElement, bridgeOrigin: string, sessionId: string) {
  const terminal = sidebar.querySelector<HTMLElement>("[data-ai-terminal]")
  if (!terminal) return
  const existing = terminal.querySelector<HTMLIFrameElement>("iframe")
  const nextSrc = `${bridgeOrigin}/bridge/session?session=${encodeURIComponent(sessionId)}`
  if (existing && existing.src === nextSrc) return
  terminal.replaceChildren()
  const frame = document.createElement("iframe")
  frame.title = `PTY session ${sessionId}`
  frame.src = nextSrc
  frame.allow = "clipboard-read; clipboard-write"
  terminal.appendChild(frame)
}

function normalizeBridgeOrigin(value: string): string | null {
  const raw = String(value || "").trim()
  if (!raw) return null
  try {
    return new URL(raw, window.location.href).origin
  } catch {
    return null
  }
}

function findBridgeOrigin(sidebar?: HTMLElement): string | null {
  const configured = normalizeBridgeOrigin(sidebar?.dataset.bridgeOrigin || "")
  if (configured) return configured

  const frame = document.querySelector<HTMLIFrameElement>(
    ".bridge-frame-card iframe[src*='/bridge/']",
  )
  return normalizeBridgeOrigin(frame?.src || "")
}

async function fetchBridgeHealth(bridgeOrigin: string): Promise<BridgeHealth> {
  const res = await fetch(`${bridgeOrigin}/api/health`, {
    method: "GET",
    headers: {
      "X-Bridge-Embed-Readonly": "1",
    },
  })
  if (!res.ok) throw new Error(`health ${res.status}`)
  return (await res.json()) as BridgeHealth
}

async function fetchFileRuntimeManifest(
  bridgeOrigin: string,
  sidebar: HTMLElement,
): Promise<FileRuntimeManifest | null> {
  const fileSlug = sidebar.dataset.fileSlug || ""
  const stateDir = sidebar.dataset.stateDir || ""
  if (!fileSlug || !stateDir) return null

  const params = new URLSearchParams({ fileSlug, stateDir })
  const res = await fetch(`${bridgeOrigin}/api/file-runtime/manifest?${params.toString()}`, {
    method: "GET",
    headers: {
      "X-Bridge-Embed-Readonly": "1",
    },
  })
  if (!res.ok) throw new Error(`manifest ${res.status}`)
  return (await res.json()) as FileRuntimeManifest
}

async function createBridgeSession(
  bridgeOrigin: string,
  sidebar: HTMLElement,
  forceNew = false,
): Promise<{ sessionId: string; resumed: boolean }> {
  applySidebarDefaults(sidebar)
  const roleId = sidebar.dataset.roleId || ""
  const agent = sidebar.dataset.agent || DEFAULT_AI_AGENT
  const cwd = sidebar.dataset.cwd || ""
  const model = sidebar.dataset.model || ""
  const difficulty = sidebar.dataset.difficulty || DEFAULT_AI_DIFFICULTY
  const workspaceId = resolveWorkspaceId(sidebar)
  const body: Record<string, string | boolean> = {
    agent,
    difficulty,
  }
  if (roleId && roleId !== "admin") body.roleId = roleId
  if (cwd) body.cwd = cwd
  if (model) body.model = model
  if (workspaceId) body.workspaceId = workspaceId
  if (forceNew) body.forceNew = true

  const endpoint = "/api/sessions"
  const res = await fetch(`${bridgeOrigin}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Role-Id": "admin",
    },
    body: JSON.stringify(body),
  })
  const payload = (await res.json().catch(() => ({}))) as BridgeSessionPayload
  const sessionId = payload.session?.id || payload.session?.sessionId || ""
  if (!res.ok || !payload.ok || !sessionId) {
    throw new Error(payload.error || `session ${res.status}`)
  }
  rememberSessionBinding(sidebar, bridgeOrigin, sessionId)
  storeSessionId(bridgeOrigin, workspaceId, sessionId)
  setAiStatus(sidebar, `${agent} PTY ready for ${workspaceId}: ${sessionId}`)
  return { sessionId, resumed: Boolean(payload.resumed) }
}

// Workspace-level primer sent ONCE per PTY session at creation time.
// Intentionally does not include the current page's slug or content —
// the agent can resolve "the current page" from conversation context
// or by reading content/ directly when the user references a note.
// Re-injection on every page nav was the prior behaviour; the user
// opted out of that ("不要再把这页的内容全灌进去了").
function buildWorkspaceContext(sidebar: HTMLElement): string {
  const workspaceId = resolveWorkspaceId(sidebar)
  const roleId = sidebar.dataset.roleId || "generalist"
  const agent = sidebar.dataset.agent || "codex"
  const cwd = sidebar.dataset.cwd || ""
  const model = sidebar.dataset.model || ""
  const lines = [
    "[QUARTZ WORKSPACE CONTEXT]",
    `workspaceId: ${workspaceId}`,
    `roleId: ${roleId}`,
    `agent: ${agent}`,
  ]
  if (cwd) lines.push(`cwd: ${cwd}`)
  if (cwd) lines.push(`workspaceRoot: ${cwd}`)
  if (model) lines.push(`model: ${model}`)
  lines.push("")
  lines.push("You are running inside the AI Workspace for this Quartz site.")
  lines.push(
    "Markdown notes live under content/ (relative to workspaceRoot). Read/edit them directly with shell tools (cat, sed, printf, tee). The Quartz dev server watches content/ and the user's browser soft-refreshes within ~1s of any save — no manual rebuild needed.",
  )
  if (cwd) {
    lines.push(
      `IMPORTANT: write files only under workspaceRoot (${cwd}). Do NOT trust your auto-memory or CLAUDE.md for "the project root" — multiple parallel quartz environments (dev/staging/prod) coexist on this machine and only workspaceRoot is authoritative for this session.`,
    )
  }
  lines.push(
    "The user's currently-open page changes as they browse; this primer is sent only at session start, so don't assume you know which page is open. When 'this page' / 'this note' matters, ask or infer from the user's words. When the user says 'record this' / 'add this' / '记下来' / '加进笔记', do it — append/edit the relevant file in content/ directly, no preamble.",
  )
  lines.push("")
  lines.push("== Navigation ==")
  lines.push(
    "You CANNOT change the user's browser URL by claiming to ('I've taken you to...'). To actually navigate the user's open tab, POST to the bridge:",
  )
  lines.push(
    `bash "$CLAUDE_PTY_ROOT/scripts/api.sh" self POST /api/sidebar/navigate '{"slug":"Thoughts/raw"}'`,
  )
  lines.push(
    "The slug is relative to the site root (no leading slash, no .md). The active sidebar receives the directive over SSE and calls window.spaNavigate. Use this for 'take me to X' / 'show me the X note' / 'open the new draft' requests.",
  )
  lines.push(
    "DO NOT use `open file://…` to surface a page — it opens the raw .md in the local editor, not the user's browser. DO NOT claim 'the route hasn't picked it up yet' — Quartz watches content/ and serves any new file at /<path-minus-content/-minus-.md> within ~1s of write. After writing content/X/Y.md, navigate to /X/Y immediately.",
  )
  lines.push(
    "Workflow: (a) write or edit the source markdown, (b) POST /api/sidebar/navigate with the destination slug, (c) confirm in one sentence what changed and where the user landed.",
  )
  lines.push("")
  lines.push("== Files & embeds (PDFs, images, other) ==")
  lines.push(
    "Any non-Markdown file under content/ is published as-is by Quartz at its slugified URL. To embed one in a note, drop the file in content/<folder>/<name>.<ext> and reference it from markdown with the Obsidian-style embed: `![[<folder>/<name>.<ext>]]`.",
  )
  lines.push(
    "Supported embed types: .pdf (rendered with a canvas-based pdf.js viewer — multi-page scroll, no flicker on reorder, gets the standard ⧉/💬/★/↕ block toolbar like text blocks); .png/.jpg/.jpeg/.gif/.bmp/.svg/.webp (native <img>); .mp4/.webm/.ogv/.mov/.mkv (native <video>); .mp3/.wav/.m4a/.ogg/.flac (native <audio>). The site config is at quartz_pty/quartz/plugins/transformers/ofm.ts if the user needs a new type.",
  )
  lines.push(
    "Typical paper workflow when the user shares an arXiv link or a PDF URL: (1) curl -sSL <pdf-url> -o content/papers/<kebab-slug>.pdf — pick a short kebab-case slug from the paper title, e.g. distilling-knowledge.pdf. (2) Create or open content/papers/<slug>.md with a `# Title` heading, a one-line link to the arXiv abs page, the `![[papers/<slug>.pdf]]` embed, and any prompts the user wants Jarvis to pre-load. (3) POST /api/sidebar/navigate {\"slug\":\"papers/<slug>\"} so the browser opens straight to the new note. The viewer block-card supports drag-reorder, copy, comment, and \"★ Jarvis-here\" (per-block AI comment).",
  )
  lines.push(
    "DO NOT inline-base64-encode files into markdown, paste binary data, or set up your own <iframe>/<embed> tags — the wikilink form is what the Quartz transformer recognises and what the canvas viewer hooks into. DO NOT save files outside content/ (won't be served); use `papers/`, `images/`, `attachments/` etc. as subfolder conventions.",
  )
  lines.push("")
  lines.push("== Bridge runtime + state ==")
  lines.push(
    "Use bridge HTTP APIs as the runtime/database boundary. Do not write private SQLite or bridge storage directly.",
  )
  lines.push("[/QUARTZ WORKSPACE CONTEXT]")
  return lines.join("\n")
}

async function fetchSessionState(
  bridgeOrigin: string,
  sessionId: string,
): Promise<BridgeSessionStatePayload> {
  const res = await fetch(`${bridgeOrigin}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    headers: {
      "X-Role-Id": "admin",
    },
  })
  if (!res.ok) throw new Error(`session state ${res.status}`)
  return (await res.json()) as BridgeSessionStatePayload
}

async function waitForSessionReady(bridgeOrigin: string, sessionId: string) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 45000) {
    const payload = await fetchSessionState(bridgeOrigin, sessionId)
    if (payload.session?.inited) return
    await new Promise((resolve) => window.setTimeout(resolve, 1500))
  }
}

async function injectWorkspaceContext(
  bridgeOrigin: string,
  sidebar: HTMLElement,
  sessionId: string,
) {
  const contextBinding = `${sessionId}:${currentPageContextBinding(sidebar)}`
  if (sidebar.dataset.workspaceContextSent === contextBinding) return
  sidebar.dataset.workspaceContextSent = contextBinding
  try {
    await waitForSessionReady(bridgeOrigin, sessionId)
    await sendSessionInput(
      bridgeOrigin,
      sessionId,
      buildWorkspaceContext(sidebar),
      "quartz-workspace-context",
    )
    setAiStatus(sidebar, `Workspace context sent to PTY ${sessionId}.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : "context injection failed"
    setAiStatus(sidebar, `Workspace context pending: ${message}`)
  }
}

async function ensureBridgeSession(
  sidebar: HTMLElement,
): Promise<{ bridgeOrigin: string; sessionId: string }> {
  const bridgeOrigin = findBridgeOrigin(sidebar)
  if (!bridgeOrigin) throw new Error("No bridge origin configured for this page.")
  let sessionId = sidebar.dataset.sessionId || ""
  if (sessionId && !activeSessionMatchesContext(sidebar, bridgeOrigin)) {
    clearSidebarSession(
      sidebar,
      "PTY session changes with this workspace. Starting the workspace PTY...",
    )
    sessionId = ""
  }
  if (!sessionId) {
    setTerminalStatus(sidebar, "Starting PTY session...")
    const result = await createBridgeSession(bridgeOrigin, sidebar)
    sessionId = result.sessionId
  }
  mountTerminalFrame(sidebar, bridgeOrigin, sessionId)
  void injectWorkspaceContext(bridgeOrigin, sidebar, sessionId)
  return { bridgeOrigin, sessionId }
}

async function sendSessionInput(
  bridgeOrigin: string,
  sessionId: string,
  text: string,
  source = "quartz-ai-workspace",
) {
  const res = await fetch(`${bridgeOrigin}/api/sessions/${encodeURIComponent(sessionId)}/input`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Role-Id": "admin",
    },
    body: JSON.stringify({
      data: text,
      submit: true,
      source,
      from: "quartz",
    }),
  })
  const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
  if (!res.ok || !payload.ok) throw new Error(payload.error || `input ${res.status}`)
}

function summarizeManifest(manifest: FileRuntimeManifest | null): string {
  if (!manifest) return "Runtime manifest not declared."
  if (!manifest.exists) return "Runtime folder missing."
  const artifacts = manifest.artifacts ?? {}
  const artifactNames = [
    artifacts.board ? "board" : "",
    artifacts.session ? "session" : "",
    artifacts.blueprint ? "blueprint" : "",
    artifacts.workspace ? "workspace" : "",
  ].filter(Boolean)
  const folders = manifest.folders ?? {}
  const runs = Array.isArray(folders.runs) ? folders.runs.length : 0
  const traces = Array.isArray(folders.traces) ? folders.traces.length : 0
  const evidence = Array.isArray(folders.evidence) ? folders.evidence.length : 0
  return `${artifactNames.length ? artifactNames.join("/") : "no artifacts"} · ${runs} runs · ${traces} traces · ${evidence} evidence`
}

async function hydrateBridgeSidebars() {
  const sidebars = Array.from(document.querySelectorAll<HTMLElement>(".ai-sidebar"))
  if (!sidebars.length) return

  for (const sidebar of sidebars) {
    const bridgeOrigin = findBridgeOrigin(sidebar)
    if (!bridgeOrigin) {
      setSidebarStatus(
        sidebar,
        "missing",
        "No bridge origin",
        "Set bridgeOrigin in frontmatter.",
        null,
      )
      continue
    }
    setSidebarStatus(sidebar, "probing", "Bridge probing", bridgeOrigin, bridgeOrigin)

    try {
      const health = await fetchBridgeHealth(bridgeOrigin)
      applyAgentAvailability(sidebar, health.agents)
      const sessionText = Number.isFinite(health.sessionCount)
        ? `${health.sessionCount} sessions`
        : "sessions unknown"
      const version = health.version?.label || health.version?.packageVersion || "version unknown"
      let manifestSummary = "Runtime manifest unavailable."
      try {
        manifestSummary = summarizeManifest(await fetchFileRuntimeManifest(bridgeOrigin, sidebar))
      } catch (error) {
        manifestSummary =
          error instanceof Error ? `Runtime ${error.message}` : "Runtime manifest failed."
      }
      setSidebarStatus(
        sidebar,
        "connected",
        `Bridge ${health.port ?? ""}`.trim(),
        `${sessionText} · ${version}`,
        bridgeOrigin,
      )
      setRuntimeMeta(sidebar, manifestSummary)

      // Resume an existing PTY session if we remember one and it's
      // still alive on the bridge. This is the path that fixes
      // "rebuild + refresh kills the PTY": the session id survives
      // in localStorage; we verify the bridge still has it; if yes,
      // re-mount the terminal frame without requiring a user click.
      const workspaceId = resolveWorkspaceId(sidebar)
      const remembered = loadStoredSessionId(bridgeOrigin, workspaceId)
      if (remembered) {
        try {
          const state = await fetchSessionState(bridgeOrigin, remembered)
          const alive = state.ok !== false && state.session && state.session.state !== "exited"
          if (alive) {
            rememberSessionBinding(sidebar, bridgeOrigin, remembered)
            mountTerminalFrame(sidebar, bridgeOrigin, remembered)
            void injectWorkspaceContext(bridgeOrigin, sidebar, remembered)
            setAiStatus(sidebar, `Resumed PTY ${remembered} for ${workspaceId}.`)
          } else {
            clearStoredSessionId(bridgeOrigin, workspaceId)
          }
        } catch {
          // Bridge doesn't know this session — it died while we were
          // away. Clear the stale id so the next Start-PTY click
          // creates fresh.
          clearStoredSessionId(bridgeOrigin, workspaceId)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "health failed"
      setSidebarStatus(sidebar, "error", "Bridge unreachable", message, bridgeOrigin)
    }
  }
}

// AI marginal comments (v0): collect every <p data-paragraph-hash>, ask
// the bridge for one-shot comments, render a widget next to each one with
// keep/dismiss/discuss buttons. v0 wires only dismiss; keep/discuss are
// disabled with a tooltip so the UI is visibly incomplete on purpose.
type AiCommentResponse = {
  ok?: boolean
  error?: string
  comments?: Array<{ hash: string; comment: string }>
}

function collectPageParagraphs(): Array<{ hash: string; text: string }> {
  const out: Array<{ hash: string; text: string }> = []
  const seen = new Set<string>()
  // Prefer .block-card[data-block-id] (works on any wrapped element type
  // — paragraphs, lists, code, headings, blockquotes…). Fall back to
  // bare <p data-paragraph-hash> on pages that don't opt into blocks.
  const cards = Array.from(document.querySelectorAll<HTMLElement>("article .block-card[data-block-id]"))
  for (const card of cards) {
    const hash = card.dataset.blockId || ""
    const text = (card.querySelector("p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, figure")?.textContent || "")
      .replace(/\s+/g, " ").trim()
    if (!hash || !text || seen.has(hash)) continue
    seen.add(hash)
    out.push({ hash, text })
  }
  if (cards.length === 0) {
    for (const p of Array.from(document.querySelectorAll<HTMLElement>("article p[data-paragraph-hash]"))) {
      const hash = p.dataset.paragraphHash || ""
      const text = (p.textContent || "").replace(/\s+/g, " ").trim()
      if (!hash || !text || seen.has(hash)) continue
      seen.add(hash)
      out.push({ hash, text })
    }
  }
  return out
}


// AI comment widget — registered with the block-widget runtime so that
// state (original comment + discussion thread + saved flag) outlives
// Quartz's hot-rebuilds. See block-widget-runtime.inline.ts for the
// Identity/State/Mount separation.

type CommentThreadTurn = {
  role: "ai" | "user"
  text: string
  /** ISO 8601. Optional for backward compatibility with state stored
   * before timestamps were added. */
  createdAt?: string
}
type AiCommentState = {
  comment: string
  /** ISO 8601 of when the original Jarvis comment was generated. */
  commentCreatedAt?: string
  thread: CommentThreadTurn[]
  /** True when the entire widget has been retired (e.g. user dismissed
   * the original AI peer). Once true, mount skips entirely. */
  saved: boolean
  /** Which peer indexes the user has explicitly dismissed from view.
   * -1 = original AI comment; 0+ = thread[i]. */
  dismissedIndexes: number[]
  /** Which peer indexes the user has liked (♥). Cosmetic only — does
   * not write to source markdown. */
  likedIndexes: number[]
}

// Reddit-style action icons. Inline SVGs to keep this asset-free.
const ICON_UPVOTE = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 2.4 14 9.6h-3.2v4H5.2v-4H2L8 2.4z"/></svg>`
const ICON_DOWNVOTE = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 13.6 2 6.4h3.2v-4h5.6v4H14L8 13.6z"/></svg>`
const ICON_REPLY = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 3h10a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H6.7L3.5 14V11.2H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/></svg>`
const ICON_CLOSE = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="m4.4 3.4 3.6 3.6 3.6-3.6 1 1L9 8l3.6 3.6-1 1L8 9l-3.6 3.6-1-1L7 8 3.4 4.4z"/></svg>`
const ICON_HEART = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 13.5 2.4 8.4a3.4 3.4 0 1 1 4.8-4.8L8 4.4l.8-.8a3.4 3.4 0 0 1 4.8 4.8L8 13.5z"/></svg>`
const ICON_DISTILL = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 2h7l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm6 1.5V5.5h2L9 3.5zM4.5 8h7v1h-7zm0 2.5h7v1h-7z"/></svg>`

// persistComment (markdown write-back) was removed in v3: widget state
// is now the canonical record (localStorage), not a stepping stone to
// markdown. Bridge endpoint /api/ai-comments/keep remains available
// for future use but is no longer called from the client.

const AI_COMMENT_WIDGET: BlockWidget<AiCommentState> = {
  type: "ai-comment",
  rootSelector: "article .block-card[data-block-id], article p[data-paragraph-hash]",
  match: (node) => {
    // Block-page mode: every wrapped block (any tag) gets data-block-id
    // on its .block-card container. Match those first.
    if (node instanceof HTMLDivElement && node.classList.contains("block-card")) {
      return node.dataset.blockId || null
    }
    // Non-blocks pages: bare <p data-paragraph-hash>. Skip if it's
    // already inside a block-card (the wrapper case is handled above).
    if (node instanceof HTMLParagraphElement && !node.closest(".block-card")) {
      return node.dataset.paragraphHash || null
    }
    return null
  },
  defaultState: () => ({ comment: "", thread: [], saved: false, dismissedIndexes: [], likedIndexes: [] }),
  mount: (node: HTMLElement, state: AiCommentState, ctx: WidgetCtx<AiCommentState>) => {
    // If this comment has been retired by ✗-on-original, skip entirely.
    if (state.saved) return
    // If there's nothing to show — no AI comment, no thread, no
    // composer-open hint — skip. (composerInitiallyOpen flag is set by
    // the block-page toolbar's "comment on this block" entry point.)
    const hasComposerHint = Boolean((state as { composerInitiallyOpen?: boolean }).composerInitiallyOpen)
    if (!state.comment && state.thread.length === 0 && !hasComposerHint) return

    // Defensive: don't double-attach if a previous mount didn't fully clean up.
    if (node.dataset.aiCommentAttached === "1") return
    node.dataset.aiCommentAttached = "1"

    // Peer-card layout: the original AI comment and every thread turn
    // (user + ai) render as siblings in a vertical list, NOT a nested
    // thread. Each AI peer gets its own ▲ ▼ 💬; each user peer gets only
    // ✗ (dismiss). Reply composer attaches to the bottom of the list and
    // is toggled on by clicking 💬 on any AI peer.
    const widget = document.createElement("aside")
    widget.className = "ai-comment-widget"
    widget.setAttribute("data-paragraph-hash", ctx.blockId)
    widget.innerHTML = `
      <div class="ai-comment-widget__peers"></div>
      <form class="ai-comment-widget__composer" hidden>
        <textarea class="ai-comment-widget__input" rows="2" placeholder="Reply… (Enter to send, Shift+Enter for newline)"></textarea>
        <div class="ai-comment-widget__composer-actions">
          <button type="submit" class="ai-comment-widget__send">Send</button>
          <button type="button" class="ai-comment-widget__collapse" data-ai-comment-action="cancel-reply">Cancel</button>
        </div>
      </form>
      <div class="ai-comment-widget__status" aria-live="polite" hidden></div>
      <div class="ai-comment-widget__footer">
        <button type="button" class="ai-comment-widget__distill-btn" data-ai-comment-action="distill-open">${ICON_DISTILL}<span>Distill to note</span></button>
      </div>
      <div class="ai-comment-widget__distill-panel" hidden>
        <div class="ai-comment-widget__distill-loading" hidden>Asking Jarvis to distill the discussion…</div>
        <div class="ai-comment-widget__distill-preview" hidden>
          <label class="ai-comment-widget__distill-label">Save to:
            <input type="text" class="ai-comment-widget__distill-path" />
          </label>
          <textarea class="ai-comment-widget__distill-content" rows="14"></textarea>
          <div class="ai-comment-widget__distill-actions">
            <button type="button" class="ai-comment-widget__distill-save" data-ai-comment-action="distill-save">Save</button>
            <button type="button" data-ai-comment-action="distill-cancel">Cancel</button>
          </div>
        </div>
      </div>
    `
    const peersEl = widget.querySelector<HTMLElement>(".ai-comment-widget__peers")!
    const statusEl = widget.querySelector<HTMLElement>(".ai-comment-widget__status")!
    const composerEl = widget.querySelector<HTMLFormElement>(".ai-comment-widget__composer")!
    const inputEl = widget.querySelector<HTMLTextAreaElement>(".ai-comment-widget__input")!
    const sendBtn = widget.querySelector<HTMLButtonElement>(".ai-comment-widget__send")!
    const distillPanel = widget.querySelector<HTMLElement>(".ai-comment-widget__distill-panel")!
    const distillLoading = widget.querySelector<HTMLElement>(".ai-comment-widget__distill-loading")!
    const distillPreview = widget.querySelector<HTMLElement>(".ai-comment-widget__distill-preview")!
    const distillPathInput = widget.querySelector<HTMLInputElement>(".ai-comment-widget__distill-path")!
    const distillContent = widget.querySelector<HTMLTextAreaElement>(".ai-comment-widget__distill-content")!
    const distillSaveBtn = widget.querySelector<HTMLButtonElement>(".ai-comment-widget__distill-save")!

    const setStatus = (msg: string, kind: "info" | "error" | "ok" = "info") => {
      statusEl.hidden = false
      statusEl.textContent = msg
      statusEl.dataset.kind = kind
    }
    const setStatusHTML = (html: string, kind: "info" | "error" | "ok" = "info") => {
      statusEl.hidden = false
      statusEl.innerHTML = html
      statusEl.dataset.kind = kind
    }
    const clearStatus = () => { statusEl.hidden = true; statusEl.textContent = "" }

    // Working copies kept in closure to avoid setState-induced remounts
    // while the user is typing. They get written through to the runtime
    // store via direct .set() so sessionStorage stays current.
    const thread: CommentThreadTurn[] = state.thread.slice()
    const dismissedIndexes = new Set<number>(state.dismissedIndexes || [])
    const likedIndexes = new Set<number>(state.likedIndexes || [])
    const persistInPlace = () => {
      state.thread = thread.slice()
      state.dismissedIndexes = Array.from(dismissedIndexes)
      state.likedIndexes = Array.from(likedIndexes)
      getBlockWidgetRuntime().set("ai-comment", ctx.blockId, state)
    }

    // Each rendered peer carries its turn index (-1 for the original AI
    // comment, 0+ for thread positions).
    function peerText(peerIndex: number): string {
      if (peerIndex === -1) return state.comment
      const turn = thread[peerIndex]
      return turn ? turn.text : ""
    }
    function peerRole(peerIndex: number): "ai" | "user" {
      if (peerIndex === -1) return "ai"
      return thread[peerIndex]?.role ?? "ai"
    }
    function peerTimestamp(peerIndex: number): string | undefined {
      if (peerIndex === -1) return state.commentCreatedAt
      return thread[peerIndex]?.createdAt
    }
    function formatTimestamp(iso: string | undefined): string {
      if (!iso) return ""
      try {
        const d = new Date(iso)
        // Compact: "May 12, 23:48". Year shown only if not the current year.
        const now = new Date()
        const sameYear = d.getFullYear() === now.getFullYear()
        const opts: Intl.DateTimeFormatOptions = sameYear
          ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
          : { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
        return d.toLocaleString(undefined, opts)
      } catch {
        return ""
      }
    }
    function renderOnePeer(peerIndex: number): HTMLElement | null {
      if (dismissedIndexes.has(peerIndex)) return null
      const role = peerRole(peerIndex)
      const text = peerText(peerIndex)
      if (!text) return null
      const card = document.createElement("div")
      card.className = `ai-comment-peer ai-comment-peer--${role}`
      card.setAttribute("data-peer-index", String(peerIndex))

      const head = document.createElement("div")
      head.className = "ai-comment-peer__head"
      const label = document.createElement("span")
      label.className = "ai-comment-peer__label"
      label.textContent = role === "ai" ? "Jarvis" : "You"
      head.appendChild(label)

      const actions = document.createElement("div")
      actions.className = "ai-comment-peer__actions"
      const liked = likedIndexes.has(peerIndex)
      // AI peers: ♥ Like (cosmetic), ✗ Dismiss, 💬 Reply.
      // User peers: only ✗ Dismiss.
      if (role === "ai") {
        actions.innerHTML = `
          <button type="button" data-ai-comment-action="like" class="ai-comment-peer__icon-button${liked ? " ai-comment-peer__icon-button--liked" : ""}" aria-label="${liked ? "Unlike" : "Like"}" title="${liked ? "Unlike" : "Like"}">${ICON_HEART}</button>
          <button type="button" data-ai-comment-action="dismiss" class="ai-comment-peer__icon-button" aria-label="Dismiss" title="Dismiss">${ICON_CLOSE}</button>
          <button type="button" data-ai-comment-action="reply" class="ai-comment-peer__icon-button" aria-label="Reply" title="Reply">${ICON_REPLY}</button>
        `
      } else {
        actions.innerHTML = `
          <button type="button" data-ai-comment-action="dismiss" class="ai-comment-peer__icon-button" aria-label="Dismiss this reply" title="Dismiss this reply">${ICON_CLOSE}</button>
        `
      }
      head.appendChild(actions)
      card.appendChild(head)

      const body = document.createElement("div")
      body.className = "ai-comment-peer__body"
      body.textContent = text
      card.appendChild(body)

      const tsText = formatTimestamp(peerTimestamp(peerIndex))
      if (tsText) {
        const ts = document.createElement("div")
        ts.className = "ai-comment-peer__timestamp"
        ts.textContent = tsText
        card.appendChild(ts)
      }
      if (liked) card.classList.add("ai-comment-peer--liked")
      return card
    }

    function renderAllPeers() {
      peersEl.innerHTML = ""
      const card = renderOnePeer(-1)
      if (card) peersEl.appendChild(card)
      for (let i = 0; i < thread.length; i++) {
        const c = renderOnePeer(i)
        if (c) peersEl.appendChild(c)
      }
    }
    renderAllPeers()

    const sidebar = document.querySelector<HTMLElement>(".ai-sidebar")

    const openComposer = () => {
      composerEl.hidden = false
      window.setTimeout(() => inputEl.focus(), 0)
    }

    // If the block-page toolbar seeded composerInitiallyOpen, open the
    // composer now and consume the flag so subsequent remounts don't
    // keep opening it after the user closes it.
    if (hasComposerHint) {
      openComposer()
      const cur = state as AiCommentState & { composerInitiallyOpen?: boolean }
      delete cur.composerInitiallyOpen
      getBlockWidgetRuntime().set("ai-comment", ctx.blockId, cur)
    }
    const closeComposer = () => {
      composerEl.hidden = true
      inputEl.value = ""
    }

    const sendReply = async () => {
      if (!sidebar) { setStatus("no sidebar", "error"); return }
      const userText = inputEl.value.trim()
      if (!userText) return
      const bridgeOrigin = findBridgeOrigin(sidebar)
      if (!bridgeOrigin) { setStatus("no bridge origin", "error"); return }
      const paragraphText = (node.textContent || "").replace(/\s+/g, " ").trim()
      thread.push({ role: "user", text: userText, createdAt: new Date().toISOString() })
      inputEl.value = ""
      renderAllPeers()
      persistInPlace()
      // Close composer immediately on send — the user's reply is already
      // visible as a peer card and the AI's response (if any) will append
      // inline when it arrives.
      closeComposer()

      // Annotation-only mode: when there's no AI original comment AND no
      // prior AI turns in the thread, this widget is a pure user-note.
      // Don't call /discuss (there's nothing for Jarvis to respond to);
      // also don't close the composer — let the user keep adding more
      // annotations on this same block without re-clicking the toolbar.
      const hasAnyAi = state.comment || thread.some((t) => t.role === "ai")
      if (!hasAnyAi) {
        clearStatus()
        sendBtn.disabled = false
        sendBtn.textContent = "Send"
        openComposer()  // re-open for the next annotation
        return
      }

      setStatus("Jarvis is thinking…", "info")
      try {
        // Bridge zod caps thread at .max(N). We slide a window of the
        // most recent turns instead of the whole history so threads
        // don't break once they outgrow the cap (originalComment +
        // paragraphText carry the original framing separately, so
        // dropping the oldest back-and-forth is safe).
        const THREAD_WINDOW = 20
        const threadForSend = thread.length > THREAD_WINDOW ? thread.slice(-THREAD_WINDOW) : thread
        const res = await fetch(`${bridgeOrigin}/api/ai-comments/discuss`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Role-Id": "admin" },
          body: JSON.stringify({ paragraphText, originalComment: state.comment, thread: threadForSend }),
        })
        const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; reply?: string }
        if (!res.ok || !payload.ok || !payload.reply) {
          throw new Error(payload.error || `bridge returned ${res.status}`)
        }
        thread.push({ role: "ai", text: payload.reply, createdAt: new Date().toISOString() })
        renderAllPeers()
        persistInPlace()
        clearStatus()
      } catch (error) {
        thread.pop()
        renderAllPeers()
        persistInPlace()
        const message = error instanceof Error ? error.message : "discuss failed"
        setStatus(`discuss failed: ${message}`, "error")
      } finally {
        sendBtn.disabled = false
        sendBtn.textContent = "Send"
        // composer already closed when send was clicked
      }
    }

    composerEl.addEventListener("submit", (event) => {
      event.preventDefault()
      void sendReply()
    })
    inputEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return
      if (event.ctrlKey || event.shiftKey || event.metaKey || event.altKey) return
      event.preventDefault()
      void sendReply()
    })

    // ── Distill (note from comment) ──────────────────────────────
    let distillContentBuffer = ""
    const closeDistill = () => {
      distillPanel.hidden = true
      distillLoading.hidden = true
      distillPreview.hidden = true
    }
    const openDistill = async () => {
      if (!sidebar) { setStatus("no sidebar", "error"); return }
      const bridgeOrigin = findBridgeOrigin(sidebar)
      if (!bridgeOrigin) { setStatus("no bridge origin", "error"); return }
      const paragraphText = (node.textContent || "").replace(/\s+/g, " ").trim()
      distillPanel.hidden = false
      distillLoading.hidden = false
      distillPreview.hidden = true
      try {
        const res = await fetch(`${bridgeOrigin}/api/ai-comments/distill`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Role-Id": "admin" },
          body: JSON.stringify({
            slug: sidebar.dataset.fileSlug || "",
            paragraphText,
            originalComment: state.comment,
            thread,
          }),
        })
        const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; filename?: string; content?: string }
        if (!res.ok || !payload.ok || !payload.content) {
          throw new Error(payload.error || `bridge returned ${res.status}`)
        }
        // Append a wikilink footer pointing back at the source page so
        // Quartz auto-generates a backlink on the source side. This is the
        // only place the bidirectional graph edge gets created — the prompt
        // deliberately tells Jarvis to write a self-standing note, so the
        // linkage MUST be added by the client (not left to model variance).
        const sourceSlug = (sidebar.dataset.fileSlug || "").replace(/^\/+|\/+$/g, "")
        const wikilinkFooter = sourceSlug ? `\n\n---\n\n*Distilled from* [[${sourceSlug}]]\n` : ""
        distillContentBuffer = payload.content + wikilinkFooter
        const safeName = (payload.filename || "distilled-note").replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "distilled-note"
        distillPathInput.value = `Thoughts/distilled/${safeName}.md`
        distillContent.value = distillContentBuffer
        distillLoading.hidden = true
        distillPreview.hidden = false
      } catch (error) {
        const message = error instanceof Error ? error.message : "distill failed"
        distillLoading.hidden = true
        distillPanel.hidden = true
        setStatus(`distill failed: ${message}`, "error")
      }
    }
    const saveDistill = async () => {
      if (!sidebar) return
      const bridgeOrigin = findBridgeOrigin(sidebar)
      if (!bridgeOrigin) { setStatus("no bridge origin", "error"); return }
      const targetPath = distillPathInput.value.trim()
      const content = distillContent.value
      if (!targetPath) { setStatus("path required", "error"); return }
      distillSaveBtn.disabled = true
      distillSaveBtn.textContent = "Saving…"
      try {
        const res = await fetch(`${bridgeOrigin}/api/ai-comments/distill/save`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Role-Id": "admin" },
          body: JSON.stringify({ path: targetPath, content }),
        })
        const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; slug?: string; filePath?: string }
        if (!res.ok || !payload.ok) throw new Error(payload.error || `bridge returned ${res.status}`)
        closeDistill()
        const slug = payload.slug || ""
        const slugUrl = slug ? `/${slug.replace(/^\/+/, "")}` : ""
        // Build a real anchor + auto-navigate after quartz finishes its
        // rebuild (~1.5-2s for a new file). The link is the user's escape
        // hatch in case the auto-nav is too fast and 404s.
        if (slugUrl) {
          const safeUrl = slugUrl.replace(/[<>"]/g, "")
          setStatusHTML(`Saved → <a href="${safeUrl}" data-distill-link>open the new note</a>`, "ok")
          window.setTimeout(() => {
            const navFn = (window as Window & { spaNavigate?: (url: URL, isBack?: boolean) => Promise<void> }).spaNavigate
            try {
              if (typeof navFn === "function") void navFn(new URL(safeUrl, window.location.origin), false)
              else window.location.assign(safeUrl)
            } catch {
              window.location.assign(safeUrl)
            }
          }, 2200)
        } else {
          setStatus(`Saved to ${payload.filePath || targetPath}`, "ok")
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "save failed"
        setStatus(`distill save failed: ${message}`, "error")
      } finally {
        distillSaveBtn.disabled = false
        distillSaveBtn.textContent = "Save"
      }
    }

    widget.addEventListener("click", async (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-ai-comment-action]")
      if (!target) return
      const action = target.dataset.aiCommentAction

      if (action === "cancel-reply") {
        closeComposer()
        return
      }

      // Widget-level actions (no peer context).
      if (action === "distill-open") { void openDistill(); return }
      if (action === "distill-cancel") { closeDistill(); return }
      if (action === "distill-save") { void saveDistill(); return }

      // Resolve which peer this action belongs to.
      const peerEl = target.closest<HTMLElement>(".ai-comment-peer")
      const peerIndexAttr = peerEl?.dataset.peerIndex
      if (peerIndexAttr === undefined) return
      const peerIndex = Number(peerIndexAttr)
      if (!Number.isFinite(peerIndex)) return

      if (action === "dismiss") {
        // Original AI dismissed → whole widget retires.
        if (peerIndex === -1) {
          ctx.destroy()
          return
        }
        dismissedIndexes.add(peerIndex)
        renderAllPeers()
        persistInPlace()
        return
      }

      if (action === "reply") {
        openComposer()
        return
      }

      if (action === "like") {
        if (likedIndexes.has(peerIndex)) likedIndexes.delete(peerIndex)
        else likedIndexes.add(peerIndex)
        renderAllPeers()
        persistInPlace()
        return
      }
    })
    node.insertAdjacentElement("afterend", widget)

    // Cleanup runs before re-mount (e.g., next attachAll after state change).
    return () => {
      widget.remove()
      delete node.dataset.aiCommentAttached
    }
  },
}

// Register the AI comment widget once at module load.
getBlockWidgetRuntime().register(AI_COMMENT_WIDGET)

async function runAiRead(sidebar: HTMLElement, button: HTMLButtonElement) {
  const bridgeOrigin = findBridgeOrigin(sidebar)
  if (!bridgeOrigin) {
    setAiStatus(sidebar, "Jarvis Read: no bridge origin configured.")
    return
  }
  const slug = sidebar.dataset.fileSlug || ""
  const allParagraphs = collectPageParagraphs()
  if (allParagraphs.length === 0) {
    setAiStatus(sidebar, "Jarvis Read: no paragraphs with stable hashes on this page.")
    return
  }
  // Skip paragraphs that already have a Jarvis comment (the user hasn't
  // dismissed). Re-running Jarvis Read is additive — it generates only
  // for paragraphs without an existing comment, leaving prior threads
  // intact. To re-roll a paragraph: dismiss its widget first, then run
  // Jarvis Read again.
  const runtime = getBlockWidgetRuntime()
  const paragraphs = allParagraphs.filter((p) => {
    const existing = runtime.get<AiCommentState>("ai-comment", p.hash)
    if (!existing) return true
    if (existing.saved) return true  // user retired it; OK to re-comment
    return false
  })
  const skipped = allParagraphs.length - paragraphs.length
  if (paragraphs.length === 0) {
    setAiStatus(sidebar, `Jarvis Read: every paragraph already has a comment (dismiss first to re-roll).`)
    return
  }
  const originalLabel = button.textContent
  button.disabled = true
  button.textContent = "Reading…"
  setAiStatus(sidebar, `Jarvis Read: sending ${paragraphs.length} paragraph${paragraphs.length === 1 ? "" : "s"}${skipped > 0 ? ` (${skipped} already commented, skipped)` : ""}...`)
  try {
    const res = await fetch(`${bridgeOrigin}/api/ai-comments/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Role-Id": "admin" },
      body: JSON.stringify({ slug, paragraphs }),
    })
    const payload = (await res.json().catch(() => ({}))) as AiCommentResponse
    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || `bridge returned ${res.status}`)
    }
    const comments = Array.isArray(payload.comments) ? payload.comments : []
    if (comments.length === 0) {
      setAiStatus(sidebar, "Jarvis Read: nothing worth commenting.")
      return
    }
    const nowIso = new Date().toISOString()
    for (const c of comments) {
      runtime.set<AiCommentState>("ai-comment", c.hash, {
        comment: c.comment,
        commentCreatedAt: nowIso,
        thread: [],
        saved: false,
        dismissedIndexes: [],
        likedIndexes: [],
      })
    }
    runtime.attachAll()
    let mounted = 0
    for (const c of comments) {
      if (document.querySelector(`article p[data-paragraph-hash="${CSS.escape(c.hash)}"]`)) {
        mounted++
      }
    }
    setAiStatus(sidebar, `Jarvis Read: ${mounted} new comment${mounted === 1 ? "" : "s"} mounted${skipped > 0 ? ` (${skipped} already-commented paragraphs preserved)` : ""}.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Jarvis Read failed"
    setAiStatus(sidebar, `Jarvis Read failed: ${message}`)
  } finally {
    button.disabled = false
    if (originalLabel) button.textContent = originalLabel
  }
}

function bindAiSidebarInteractions() {
  ensureGlobalAiHost()
  for (const sidebar of Array.from(document.querySelectorAll<HTMLElement>(".ai-sidebar"))) {
    if (sidebar.dataset.aiBound === "1") continue
    sidebar.dataset.aiBound = "1"

    const composer = sidebar.querySelector<HTMLFormElement>("[data-ai-composer]")
    const textarea = sidebar.querySelector<HTMLTextAreaElement>(".ai-sidebar__textarea")
    const clientSelect = sidebar.querySelector<HTMLSelectElement>("[data-ai-client-select]")
    const onSubmit = async (event: SubmitEvent) => {
      event.preventDefault()
      const value = (textarea?.value ?? "").trim()
      if (!value) return
      setAiStatus(sidebar, "Sending to PTY...")
      try {
        const { bridgeOrigin, sessionId } = await ensureBridgeSession(sidebar)
        await sendSessionInput(bridgeOrigin, sessionId, value)
        setAiStatus(sidebar, `Sent to PTY ${sessionId}.`)
      } catch (error) {
        const message = error instanceof Error ? error.message : "session input failed"
        setAiStatus(sidebar, `PTY input failed: ${message}`)
      }
      if (textarea) textarea.value = ""
    }
    composer?.addEventListener("submit", onSubmit)
    const onTextareaKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing) return
      if (event.ctrlKey || event.shiftKey || event.metaKey || event.altKey) return
      event.preventDefault()
      composer?.requestSubmit()
    }
    textarea?.addEventListener("keydown", onTextareaKeydown)
    const onClientChange = async () => {
      if (!clientSelect) return
      const nextAgent = clientSelect.value || DEFAULT_AI_AGENT
      if (nextAgent === "coze") {
        setAiStatus(sidebar, "Coze is not wired into the bridge runtime yet.")
        syncClientSelector(sidebar)
        return
      }
      sidebar.dataset.agent = nextAgent
      sidebar.dataset.agentLocked = "1"
      const defaultModel = defaultModelForAgent(nextAgent)
      if (defaultModel) sidebar.dataset.model = defaultModel
      else delete sidebar.dataset.model
      if (!sidebar.dataset.difficulty) sidebar.dataset.difficulty = DEFAULT_AI_DIFFICULTY
      delete sidebar.dataset.sessionId
      delete sidebar.dataset.workspaceContextSent
      clientSelect.disabled = true
      setTerminalStatus(sidebar, `Starting ${nextAgent} PTY...`)
      setAiStatus(sidebar, `Switching AI client to ${nextAgent}...`)
      try {
        const bridgeOrigin = findBridgeOrigin(sidebar)
        if (!bridgeOrigin) throw new Error("No bridge origin configured for this page.")
        const result = await createBridgeSession(bridgeOrigin, sidebar, true)
        mountTerminalFrame(sidebar, bridgeOrigin, result.sessionId)
        void injectWorkspaceContext(bridgeOrigin, sidebar, result.sessionId)
        setAiStatus(sidebar, `Switched to ${nextAgent}: ${result.sessionId}.`)
      } catch (error) {
        const message = error instanceof Error ? error.message : "client switch failed"
        setTerminalStatus(sidebar, `Client switch failed: ${message}`)
        setAiStatus(sidebar, `Client switch failed: ${message}`)
      } finally {
        clientSelect.disabled = false
        syncClientSelector(sidebar)
      }
    }
    clientSelect?.addEventListener("change", onClientChange)
    window.addCleanup(() => {
      composer?.removeEventListener("submit", onSubmit)
      textarea?.removeEventListener("keydown", onTextareaKeydown)
      clientSelect?.removeEventListener("change", onClientChange)
      delete sidebar.dataset.aiBound
    })

    for (const button of Array.from(
      sidebar.querySelectorAll<HTMLButtonElement>("[data-ai-action]"),
    )) {
      const onClick = () => {
        const action = button.dataset.aiAction || "action"
        if (action === "refresh") {
          hydrateBridgeSidebars()
          setAiStatus(sidebar, "Bridge state refreshed.")
          return
        }
        if (action === "start-pty" || action === "run-block") {
          void ensureBridgeSession(sidebar)
            .then(({ sessionId }) => setAiStatus(sidebar, `PTY ${sessionId} is attached.`))
            .catch((error) => {
              const message = error instanceof Error ? error.message : "session start failed"
              setTerminalStatus(sidebar, `PTY start failed: ${message}`)
              setAiStatus(sidebar, `PTY start failed: ${message}`)
            })
          return
        }
        if (action === "ai-read") {
          void runAiRead(sidebar, button)
          return
        }
        setAiStatus(
          sidebar,
          `${button.textContent?.trim() || action} is queued behind M6 write coordination.`,
        )
      }
      button.addEventListener("click", onClick)
      window.addCleanup(() => button.removeEventListener("click", onClick))
    }
  }
}

document.addEventListener("nav", () => {
  ensureGlobalAiHost()
  bindAiSidebarInteractions()
  hydrateBridgeSidebars()
  getBlockWidgetRuntime().attachAll()
})

const startAiSidebar = () => {
  ensureGlobalAiHost()
  bindAiSidebarInteractions()
  hydrateBridgeSidebars()
  ensureSidebarEventStream()
}

// ── Bridge → sidebar control channel (SSE) ──────────────────────────
// Long-lived EventSource on /api/sidebar/events. Today the only event
// is "navigate" — Jarvis sessions POST /api/sidebar/navigate, the
// bridge fans the message out to all open sidebars, and this listener
// soft-navigates the user's tab via window.spaNavigate.
let sidebarEventSource: EventSource | null = null
function ensureSidebarEventStream(): void {
  if (sidebarEventSource && sidebarEventSource.readyState !== EventSource.CLOSED) return
  const sidebar = document.querySelector<HTMLElement>(".ai-sidebar")
  const bridgeOrigin = sidebar?.getAttribute("data-bridge-origin") || ""
  if (!bridgeOrigin) return
  try {
    const es = new EventSource(`${bridgeOrigin}/api/sidebar/events`)
    sidebarEventSource = es
    es.addEventListener("navigate", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data || "{}") as { slug?: string }
        const slug = (data.slug || "").replace(/^\/+|\/+$/g, "")
        if (!slug) return
        const url = new URL(`/${slug}`, window.location.origin)
        const navFn = (window as Window & { spaNavigate?: (u: URL, isBack?: boolean) => Promise<void> }).spaNavigate
        if (typeof navFn === "function") void navFn(url, false)
        else window.location.assign(url.toString())
      } catch (err) {
        console.warn("sidebar navigate event parse failed:", err)
      }
    })
    es.onerror = () => {
      // Browser auto-retries EventSource. Don't close; let it reconnect.
    }
  } catch (err) {
    console.warn("sidebar SSE setup failed:", err)
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startAiSidebar, { once: true })
} else {
  window.setTimeout(startAiSidebar, 0)
}
