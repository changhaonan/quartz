import { getBlockWidgetRuntime, BlockWidget, WidgetCtx } from "./block-widget-runtime.inline"

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

function currentPageContextBinding(sidebar: HTMLElement): string {
  return JSON.stringify([
    resolveWorkspaceId(sidebar),
    sidebar.dataset.fileSlug || "",
    sidebar.dataset.stateDir || "",
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

function buildWorkspaceContext(sidebar: HTMLElement): string {
  const workspaceId = resolveWorkspaceId(sidebar)
  const pageWorkspaceId = sidebar.dataset.workspaceId || "not declared"
  const fileSlug = sidebar.dataset.fileSlug || "unknown"
  const stateDir = sidebar.dataset.stateDir || ""
  const roleId = sidebar.dataset.roleId || "generalist"
  const agent = sidebar.dataset.agent || "codex"
  const cwd = sidebar.dataset.cwd || ""
  const model = sidebar.dataset.model || ""
  const lines = [
    "[QUARTZ WORKSPACE CONTEXT]",
    `workspaceId: ${workspaceId}`,
    `pageWorkspaceId: ${pageWorkspaceId}`,
    `fileSlug: ${fileSlug}`,
    `stateDir: ${stateDir}`,
    `roleId: ${roleId}`,
    `agent: ${agent}`,
  ]
  if (cwd) lines.push(`cwd: ${cwd}`)
  if (cwd) lines.push(`workspaceRoot: ${cwd}`)
  if (model) lines.push(`model: ${model}`)
  lines.push("")
  lines.push("You are running inside the AI Workspace for this Quartz page.")
  lines.push(
    "Treat this Markdown file as the source of intent and its declared .runtime folder as the page-owned artifact store.",
  )
  if (cwd) {
    lines.push(
      `IMPORTANT: write files only under workspaceRoot (${cwd}). Do NOT trust your auto-memory or CLAUDE.md for "the project root" — multiple parallel quartz environments (dev/staging/prod) coexist on this machine and only workspaceRoot is authoritative for this session.`,
    )
  }
  lines.push(
    "Use bridge HTTP APIs as the runtime/database boundary. Do not write private SQLite or bridge storage directly.",
  )
  if (fileSlug && stateDir) {
    lines.push("Useful read path:")
    lines.push(
      `bash "$CLAUDE_PTY_ROOT/scripts/api.sh" self GET '/api/file-runtime/manifest?fileSlug=${encodeURIComponent(fileSlug)}&stateDir=${encodeURIComponent(stateDir)}'`,
    )
  } else {
    lines.push("Useful read path:")
    lines.push("Runtime manifest not declared for this page.")
  }
  lines.push(
    "If the user asks for a mutation and no file-runtime write API exists yet, explain the intended scoped edit before changing files.",
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
  for (const p of Array.from(document.querySelectorAll<HTMLElement>("article p[data-paragraph-hash]"))) {
    const hash = p.dataset.paragraphHash || ""
    const text = (p.textContent || "").replace(/\s+/g, " ").trim()
    if (!hash || !text || seen.has(hash)) continue
    seen.add(hash)
    out.push({ hash, text })
  }
  return out
}


// AI comment widget — registered with the block-widget runtime so that
// state (original comment + discussion thread + saved flag) outlives
// Quartz's hot-rebuilds. See block-widget-runtime.inline.ts for the
// Identity/State/Mount separation.

type CommentThreadTurn = { role: "ai" | "user"; text: string }
type AiCommentState = {
  comment: string
  thread: CommentThreadTurn[]
  /** True when the entire widget has been retired (e.g. user dismissed
   * the original AI peer). Once true, mount skips entirely. */
  saved: boolean
  /** Which peer indexes the user has explicitly dismissed from view.
   * -1 = original AI comment; 0+ = thread[i]. */
  dismissedIndexes: number[]
}

// Reddit-style action icons. Inline SVGs to keep this asset-free.
const ICON_UPVOTE = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 2.4 14 9.6h-3.2v4H5.2v-4H2L8 2.4z"/></svg>`
const ICON_DOWNVOTE = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 13.6 2 6.4h3.2v-4h5.6v4H14L8 13.6z"/></svg>`
const ICON_REPLY = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 3h10a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H6.7L3.5 14V11.2H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/></svg>`
const ICON_CLOSE = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="m4.4 3.4 3.6 3.6 3.6-3.6 1 1L9 8l3.6 3.6-1 1L8 9l-3.6 3.6-1-1L7 8 3.4 4.4z"/></svg>`

// persistComment (markdown write-back) was removed in v3: widget state
// is now the canonical record (localStorage), not a stepping stone to
// markdown. Bridge endpoint /api/ai-comments/keep remains available
// for future use but is no longer called from the client.

const AI_COMMENT_WIDGET: BlockWidget<AiCommentState> = {
  type: "ai-comment",
  rootSelector: "article p[data-paragraph-hash]",
  match: (node) => {
    if (!(node instanceof HTMLParagraphElement)) return null
    return node.dataset.paragraphHash || null
  },
  defaultState: () => ({ comment: "", thread: [], saved: false, dismissedIndexes: [] }),
  mount: (node: HTMLElement, state: AiCommentState, ctx: WidgetCtx<AiCommentState>) => {
    // If this comment has been persisted to markdown, the source rebuild
    // brings the blockquote in; nothing to paint client-side.
    if (state.saved || !state.comment) return

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
    `
    const peersEl = widget.querySelector<HTMLElement>(".ai-comment-widget__peers")!
    const statusEl = widget.querySelector<HTMLElement>(".ai-comment-widget__status")!
    const composerEl = widget.querySelector<HTMLFormElement>(".ai-comment-widget__composer")!
    const inputEl = widget.querySelector<HTMLTextAreaElement>(".ai-comment-widget__input")!
    const sendBtn = widget.querySelector<HTMLButtonElement>(".ai-comment-widget__send")!

    const setStatus = (msg: string, kind: "info" | "error" | "ok" = "info") => {
      statusEl.hidden = false
      statusEl.textContent = msg
      statusEl.dataset.kind = kind
    }
    const clearStatus = () => { statusEl.hidden = true; statusEl.textContent = "" }

    // Working copies kept in closure to avoid setState-induced remounts
    // while the user is typing. They get written through to the runtime
    // store via direct .set() so sessionStorage stays current.
    const thread: CommentThreadTurn[] = state.thread.slice()
    const dismissedIndexes = new Set<number>(state.dismissedIndexes || [])
    const persistInPlace = () => {
      state.thread = thread.slice()
      state.dismissedIndexes = Array.from(dismissedIndexes)
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
      // v3 simplification: widget state IS the canonical record (no
      // markdown write-back). Only two actions: ✗ dismiss + 💬 reply.
      // "Not dismissed" == "kept" — persistence is via localStorage.
      if (role === "ai") {
        actions.innerHTML = `
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
      thread.push({ role: "user", text: userText })
      inputEl.value = ""
      renderAllPeers()
      persistInPlace()
      // Close composer immediately on send — the user's reply is already
      // visible as a peer card and the AI's response will appear inline
      // when it arrives. Status line shows the "thinking" indicator so
      // the user knows something's happening.
      closeComposer()
      setStatus("Jarvis is thinking…", "info")
      try {
        const res = await fetch(`${bridgeOrigin}/api/ai-comments/discuss`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Role-Id": "admin" },
          body: JSON.stringify({ paragraphText, originalComment: state.comment, thread }),
        })
        const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; reply?: string }
        if (!res.ok || !payload.ok || !payload.reply) {
          throw new Error(payload.error || `bridge returned ${res.status}`)
        }
        thread.push({ role: "ai", text: payload.reply })
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

    widget.addEventListener("click", async (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-ai-comment-action]")
      if (!target) return
      const action = target.dataset.aiCommentAction

      if (action === "cancel-reply") {
        closeComposer()
        return
      }

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
    for (const c of comments) {
      runtime.set<AiCommentState>("ai-comment", c.hash, {
        comment: c.comment,
        thread: [],
        saved: false,
        dismissedIndexes: [],
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
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startAiSidebar, { once: true })
} else {
  window.setTimeout(startAiSidebar, 0)
}
