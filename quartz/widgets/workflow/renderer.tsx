/** @jsxRuntime classic */
import React from "react"
import { createRoot, type Root } from "react-dom/client"
import { Code2, Play } from "lucide-react"
import type { JsonPatchOp, WidgetMountContext } from "../types"
import type { WorkflowBoardData, WorkflowNode } from "./schema"
import { nodeVisualKind } from "./schema"
import BoardCanvas from "../_canvas/BoardCanvas"
import { WORKFLOW_PALETTE, type WorkflowPaletteEntry } from "./palette"
import { generateWorkflowSource } from "./codegen"

// Workflow's data has additional executable fields (op, params, outputs,
// kind, varName). The shared canvas only knows about visual fields. We
// project workflow → canvas-shape on render and forward edits through a
// patch translator so writes hit /workflow.json correctly.

interface CanvasNode {
  id: string
  type: string
  containerId: string
  x: number
  y: number
  width?: number
  height?: number
  text: string
  color: string
  ioPairs: number
  loopCount: number
}

interface CanvasEdge {
  id: string
  type: "arrow"
  source: string
  target: string
  sourceHandle: string
  targetHandle: string
  label: string
  color: string
  route: { x: number; y: number } | null
}

interface CanvasData {
  schemaVersion: number
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

function nodeToCanvas(node: WorkflowNode): CanvasNode {
  const visual = nodeVisualKind(node)
  const opLine = node.op ? `${node.op}(${node.outputs.join(", ") || "out"})` : ""
  // First line of canvas text doubles as a code-ish hint; second line is
  // free-form description. The illustration node renderer wraps both.
  const text = [opLine, node.text].filter(Boolean).join("\n")
  return {
    id: node.id,
    type: visual,
    containerId: node.containerId,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    text,
    color: node.color,
    ioPairs: node.ioPairs,
    loopCount: node.loopCount,
  }
}

function edgeToCanvas(edge: WorkflowBoardData["edges"][number]): CanvasEdge {
  return {
    id: edge.id,
    type: "arrow",
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    label: edge.varName || edge.label || "",
    color: edge.color,
    route: edge.route,
  }
}

function projectToCanvas(data: WorkflowBoardData): CanvasData {
  return {
    schemaVersion: data.schemaVersion,
    nodes: data.nodes.map(nodeToCanvas),
    edges: data.edges.map(edgeToCanvas),
  }
}

// Patch translator: the canvas emits patches against the projected shape
// (illustration-style). For positional updates / additions / removals on
// /nodes and /edges, those map 1:1 to the workflow document because we
// preserve order. For canvas-side `text` / `label` writes we route them
// onto workflow's `op` (when "text" looks like a function call) or fall
// back to `text` otherwise. v1: forward almost everything verbatim and
// rely on the workflow-specific toolbar for op/varName editing.

function translatePatch(
  patch: JsonPatchOp[],
  newNodeFromPalette: (entry: WorkflowPaletteEntry) => WorkflowNode,
): JsonPatchOp[] {
  return patch.map((op) => {
    // Add node from canvas palette: convert canvas-node literal back into a
    // workflow node by enriching with kind/op/outputs from WORKFLOW_PALETTE.
    if (op.op === "add" && op.path === "/nodes/-" && typeof op.value === "object" && op.value !== null) {
      const v = op.value as Record<string, unknown>
      const visualType = String(v.type || "process")
      const paletteEntry = WORKFLOW_PALETTE.find((p: WorkflowPaletteEntry) => p.visual === visualType)
        ?? WORKFLOW_PALETTE.find((p: WorkflowPaletteEntry) => p.type === "call")!
      const fresh = newNodeFromPalette(paletteEntry)
      return {
        op: "add",
        path: "/nodes/-",
        value: {
          ...fresh,
          x: Number(v.x ?? fresh.x),
          y: Number(v.y ?? fresh.y),
          width: typeof v.width === "number" ? v.width : fresh.width,
          height: typeof v.height === "number" ? v.height : fresh.height,
          color: typeof v.color === "string" ? v.color : fresh.color,
          text: typeof v.text === "string" ? v.text : fresh.text,
        },
      }
    }
    // Add edge from canvas: also enrich with empty varName.
    if (op.op === "add" && op.path === "/edges/-" && typeof op.value === "object" && op.value !== null) {
      const v = op.value as Record<string, unknown>
      return {
        op: "add",
        path: "/edges/-",
        value: {
          ...v,
          varName: typeof v.varName === "string" ? v.varName : "",
          label: typeof v.label === "string" ? v.label : "",
        },
      }
    }
    return op
  })
}

function newWorkflowNodeFromPaletteEntry(entry: WorkflowPaletteEntry): WorkflowNode {
  // Seed sensible defaults so a freshly-dragged node generates runnable
  // code immediately. Input nodes in particular need an inputType + label
  // for the Gradio form to render a meaningful prompt.
  const params: Record<string, unknown> = {}
  if (entry.type === "input") {
    params.inputType = "text"
    params.label = "Input"
  }
  return {
    id: `workflow-node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: entry.type as WorkflowNode["kind"],
    visual: entry.visual as WorkflowNode["visual"],
    op: entry.op,
    params: params as WorkflowNode["params"],
    outputs: [entry.type === "branch" || entry.type === "loop" ? "" : "out"].filter(Boolean) as string[],
    containerId: "",
    x: 0,
    y: 0,
    text: entry.defaultText,
    color: entry.color as WorkflowNode["color"],
    ioPairs: 1,
    loopCount: entry.type === "loop" ? 3 : 1,
  } as WorkflowNode
}

function applyPatchLocal(doc: unknown, ops: JsonPatchOp[]): unknown {
  const root: { v: unknown } = { v: structuredClone(doc) }
  const decode = (pointer: string): (string | number)[] => {
    if (!pointer || pointer === "/") return []
    return pointer.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
  }
  for (const op of ops) {
    const segs = decode(op.path)
    const last = segs.pop() as string | undefined
    let parent: unknown = root
    let key: string | number = "v"
    for (const seg of segs) {
      const next = (parent as Record<string | number, unknown>)[key]
      parent = next
      key = Array.isArray(parent) ? Number(seg) : seg
    }
    const target = (parent as Record<string | number, unknown>)[key] as unknown
    const tr = target as Record<string | number, unknown>
    const finalKey = Array.isArray(target)
      ? last === "-"
        ? (target as unknown[]).length
        : Number(last)
      : (last as string)
    if (op.op === "replace") {
      tr[finalKey] = (op as { value: unknown }).value
    } else if (op.op === "add") {
      if (Array.isArray(target)) {
        if (last === "-") (target as unknown[]).push((op as { value: unknown }).value)
        else (target as unknown[]).splice(Number(finalKey), 0, (op as { value: unknown }).value)
      } else {
        tr[finalKey] = (op as { value: unknown }).value
      }
    } else if (op.op === "remove") {
      if (Array.isArray(target)) (target as unknown[]).splice(Number(finalKey), 1)
      else delete tr[finalKey]
    }
  }
  return root.v
}

function exportButtonElement(onClick: () => void): React.ReactElement {
  // We avoid JSX in this .tsx file because the project's tsconfig pins
  // jsxImportSource to preact for the SSG side; using React.createElement
  // keeps the React runtime independent.
  return React.createElement(
    "button",
    {
      type: "button",
      className: "illustration-board__toolbar-btn",
      onClick,
      title: "Export this workflow as TypeScript",
    },
    React.createElement(Code2, { size: 14, strokeWidth: 2.2 }),
    React.createElement("span", null, "Export TS"),
  )
}

function runButtonElement(
  onClick: () => void,
  busy: boolean,
): React.ReactElement {
  return React.createElement(
    "button",
    {
      type: "button",
      className: "illustration-board__toolbar-btn",
      onClick,
      title: "Run this workflow against the live bridge",
      disabled: busy,
    },
    React.createElement(Play, { size: 14, strokeWidth: 2.2 }),
    React.createElement("span", null, busy ? "Running…" : "Run"),
  )
}

function toolbarRightCluster(
  onExport: () => void,
  onRun: () => void,
  running: boolean,
): React.ReactElement {
  return React.createElement(
    React.Fragment,
    null,
    runButtonElement(onRun, running),
    exportButtonElement(onExport),
  )
}

// ─── Run panel state types + form helpers ─────────────────────────────

interface UserInputSpec {
  inputType: "text" | "number" | "select" | "boolean"
  label?: string
  default?: string | number | boolean
  options?: string[]
  help?: string
  timeoutMs?: number
}

interface PendingInputRequest {
  reqId: string
  runId?: string
  requestedAt?: string
  spec: UserInputSpec
}

type RunPanelState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "input" }
  | { kind: "done"; payload: unknown }
  | { kind: "error"; message: string }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function sameRequests(a: PendingInputRequest[], b: PendingInputRequest[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].reqId !== b[i].reqId) return false
  }
  return true
}

function runPanelBodyText(state: RunPanelState): string {
  if (state.kind === "running") return "Running workflow…"
  if (state.kind === "input") return "Waiting for input."
  if (state.kind === "error") return state.message
  if (state.kind === "done") {
    const p = (state.payload ?? {}) as {
      ok?: boolean
      runId?: string
      runDir?: string
      exitCode?: number
      timedOut?: boolean
      stdout?: string
      stderr?: string
      result?: unknown
    }
    const lines: string[] = []
    lines.push(`runId: ${p.runId ?? "?"}`)
    lines.push(`runDir: ${p.runDir ?? "?"}`)
    lines.push(`exitCode: ${p.exitCode ?? "?"}${p.timedOut ? " (timed out)" : ""}`)
    if (p.result !== undefined) {
      lines.push("")
      lines.push("--- result ---")
      lines.push(typeof p.result === "string" ? p.result : JSON.stringify(p.result, null, 2))
    }
    if (p.stdout) {
      lines.push("")
      lines.push("--- stdout ---")
      lines.push(p.stdout)
    }
    if (p.stderr) {
      lines.push("")
      lines.push("--- stderr ---")
      lines.push(p.stderr)
    }
    return lines.join("\n")
  }
  return ""
}

/**
 * Build the Gradio-style form for a single pending userInput() request.
 * Renders the appropriate widget for `spec.inputType` and wires Enter
 * (or click on Submit) to call onSubmit(reqId, value).
 *
 * `carriedValue` is the field's value from the prior redraw — preserved
 * across poll-triggered re-renders so typing isn't lost.
 */
function buildInputForm(
  req: PendingInputRequest,
  carriedValue: string | undefined,
  onSubmit: (reqId: string, value: string | number | boolean) => void,
): HTMLElement {
  const root = document.createElement("div")
  root.className = "workflow-board__input-row"
  root.dataset.reqId = req.reqId

  const labelText = req.spec.label || req.spec.inputType
  const label = document.createElement("label")
  label.className = "workflow-board__input-label"
  label.textContent = labelText
  root.appendChild(label)

  let field: HTMLInputElement | HTMLSelectElement
  if (req.spec.inputType === "select") {
    const sel = document.createElement("select")
    sel.className = "workflow-board__input-field"
    for (const opt of req.spec.options ?? []) {
      const o = document.createElement("option")
      o.value = opt
      o.textContent = opt
      sel.appendChild(o)
    }
    if (carriedValue !== undefined) sel.value = carriedValue
    else if (req.spec.default !== undefined) sel.value = String(req.spec.default)
    field = sel
  } else if (req.spec.inputType === "boolean") {
    const cb = document.createElement("input")
    cb.type = "checkbox"
    cb.className = "workflow-board__input-field"
    if (carriedValue !== undefined) cb.checked = carriedValue === "true"
    else cb.checked = req.spec.default === true
    field = cb
  } else if (req.spec.inputType === "number") {
    const n = document.createElement("input")
    n.type = "number"
    n.className = "workflow-board__input-field"
    n.value = carriedValue ?? (req.spec.default != null ? String(req.spec.default) : "")
    field = n
  } else {
    const t = document.createElement("input")
    t.type = "text"
    t.className = "workflow-board__input-field"
    t.value = carriedValue ?? (req.spec.default != null ? String(req.spec.default) : "")
    field = t
  }
  field.dataset.reqId = req.reqId

  // Enter submits for single-line inputs. Shift+Enter would be a natural
  // multi-line hook later, but our v1 inputs are all single-value.
  field.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent
    if (ke.key === "Enter" && !ke.shiftKey) {
      e.preventDefault()
      submit()
    }
  })
  root.appendChild(field)

  if (req.spec.help) {
    const help = document.createElement("div")
    help.className = "workflow-board__input-help"
    help.textContent = req.spec.help
    root.appendChild(help)
  }

  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = "workflow-board__input-submit"
  btn.textContent = "Submit"
  btn.addEventListener("click", submit)
  root.appendChild(btn)

  function submit() {
    let value: string | number | boolean
    if (field instanceof HTMLInputElement) {
      if (field.type === "checkbox") value = field.checked
      else if (field.type === "number") value = field.value === "" ? 0 : Number(field.value)
      else value = field.value
    } else {
      value = (field as HTMLSelectElement).value
    }
    onSubmit(req.reqId, value)
  }

  return root
}

export function mountWorkflowBoard(
  ctx: WidgetMountContext<WorkflowBoardData>,
): () => void {
  if (!ctx.data) {
    ctx.el.innerHTML = '<div class="quartz-widget__error">Workflow data not loaded.</div>'
    return () => {
      ctx.el.innerHTML = ""
    }
  }

  const wrap = document.createElement("div")
  wrap.className = "illustration-board-frame"
  wrap.dataset.mode = ctx.mode

  const chrome = document.createElement("div")
  chrome.className = "illustration-board-frame__chrome"
  const modeBadge = document.createElement("span")
  modeBadge.className = "illustration-board-frame__mode"
  modeBadge.textContent = ctx.mode
  const status = document.createElement("span")
  status.className = "illustration-board-frame__status"
  status.textContent =
    ctx.mode === "live"
      ? "Drag · click · Del to delete · drag handle to connect · Export TS for agent code"
      : "Read-only"
  chrome.appendChild(modeBadge)
  chrome.appendChild(status)

  const canvasHost = document.createElement("div")
  canvasHost.className = "illustration-board-frame__canvas"

  wrap.appendChild(chrome)
  wrap.appendChild(canvasHost)
  ctx.el.innerHTML = ""
  ctx.el.appendChild(wrap)

  let currentData: WorkflowBoardData = ctx.data
  let saving = false
  let pendingOps: JsonPatchOp[] = []

  const setStatus = (
    kind: "idle" | "saving" | "saved" | "error",
    message?: string,
  ) => {
    status.classList.remove(
      "illustration-board-frame__status--saving",
      "illustration-board-frame__status--saved",
      "illustration-board-frame__status--error",
    )
    if (kind === "saving") {
      status.classList.add("illustration-board-frame__status--saving")
      status.textContent = "Saving…"
    } else if (kind === "saved") {
      status.classList.add("illustration-board-frame__status--saved")
      status.textContent = "Saved"
    } else if (kind === "error") {
      status.classList.add("illustration-board-frame__status--error")
      status.textContent = `Error: ${message ?? "write failed"}`
    } else {
      status.textContent =
        ctx.mode === "live"
          ? "Drag · click · Del to delete · drag handle to connect · Export TS for agent code"
          : "Read-only"
    }
  }

  const handleChange = async (canvasOps: JsonPatchOp[]) => {
    if (!canvasOps || canvasOps.length === 0) return
    if (!ctx.capabilities.canWrite) return
    const ops = translatePatch(canvasOps, newWorkflowNodeFromPaletteEntry)

    const previousData = currentData
    let nextData: WorkflowBoardData
    try {
      nextData = applyPatchLocal(currentData, ops) as WorkflowBoardData
    } catch (e) {
      setStatus("error", (e as Error).message)
      return
    }
    currentData = nextData
    renderRoot()

    if (saving) {
      pendingOps.push(...ops)
      return
    }
    saving = true
    setStatus("saving")
    const result = await ctx.write({ patch: ops })
    saving = false
    if (result.ok) {
      setStatus("saved")
      window.setTimeout(() => setStatus("idle"), 1500)
      if (pendingOps.length > 0) {
        const drained = pendingOps
        pendingOps = []
        void handleChange(drained)
      }
    } else {
      setStatus("error", result.error?.message)
      currentData = previousData
      pendingOps = []
      renderRoot()
    }
  }

  const handleExport = () => {
    const result = generateWorkflowSource(currentData, { entryName: "workflow" })
    if (result.warnings.length > 0) {
      console.warn("[workflow-board] codegen warnings:", result.warnings)
    }
    // Open a transient overlay with the generated TS so the user can copy
    // it. Click outside (or close button) to dismiss.
    showCodePanel("Generated TypeScript", result.source)
  }

  let running = false
  // Active poll cycle for human-in-the-loop input prompts. While a run is
  // in flight, this fires every ~500ms, asks the server for any pending
  // userInput() requests, and renders a Gradio-style form for them.
  let pollAbort: AbortController | null = null
  let pendingRequests: PendingInputRequest[] = []
  // Snapshot of the runs we've already returned answers for, so submitted
  // forms disappear immediately without waiting for the next poll cycle
  // (and don't reappear if the server hasn't observed the response yet).
  let optimisticallyResolved = new Set<string>()
  // Live progress tail. While a run is in flight, /api/workflow/active-runs
  // tells us which run dir to look at; we then fetch its stdout.log every
  // ~1s and surface the most recent lines above the result/form area.
  let progressTail: string = ""
  let activeRunId: string | null = null
  // Single source of truth for what the Run overlay currently shows.
  let runPanelState: RunPanelState = { kind: "idle" }

  const handleRun = async () => {
    if (running) return
    if (!ctx.capabilities.workspaceId) {
      runPanelState = {
        kind: "error",
        message: "No workspaceId — set frontmatter `workspaceId: <id>` on the page.",
      }
      drawRunPanel()
      return
    }
    const workspaceId = ctx.capabilities.workspaceId
    const gen = generateWorkflowSource(currentData, { entryName: "workflow" })
    if (gen.warnings.length > 0) {
      console.warn("[workflow-board] codegen warnings:", gen.warnings)
    }
    running = true
    renderRoot()
    pendingRequests = []
    optimisticallyResolved = new Set<string>()
    progressTail = ""
    activeRunId = null
    runPanelState = { kind: "running" }
    drawRunPanel()

    pollAbort = new AbortController()
    void pollPendingInputs(workspaceId, pollAbort.signal)
    void pollProgress(workspaceId, pollAbort.signal)

    let res: Response
    try {
      res = await fetch("/api/workflow/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          source: gen.source,
          entryName: "workflow",
          entryParams: [],
          // 30min upper bound — comfortably above the runtime's default
          // userInput timeout (10min) so a slow human doesn't make the
          // subprocess hang and the HTTP connection both fail at once.
          timeoutMs: 30 * 60_000,
        }),
      })
    } catch (e) {
      pollAbort?.abort()
      pollAbort = null
      running = false
      renderRoot()
      runPanelState = { kind: "error", message: `Network error: ${(e as Error).message}` }
      drawRunPanel()
      return
    }
    let body: unknown = null
    try {
      body = await res.json()
    } catch {}
    pollAbort?.abort()
    pollAbort = null
    pendingRequests = []
    running = false
    renderRoot()
    runPanelState = res.ok
      ? { kind: "done", payload: body }
      : { kind: "error", message: JSON.stringify(body, null, 2) }
    drawRunPanel()
  }

  const pollPendingInputs = async (workspaceId: string, signal: AbortSignal) => {
    const url = `/api/workflow/pending-inputs?workspaceId=${encodeURIComponent(workspaceId)}`
    while (!signal.aborted) {
      try {
        const r = await fetch(url, { signal })
        if (r.ok) {
          const j = (await r.json()) as { pending?: PendingInputRequest[] }
          const next = (j.pending ?? []).filter(
            (p) => !optimisticallyResolved.has(p.reqId),
          )
          // Once the server has written a response.json, it'll drop the
          // reqId from the next /pending-inputs response. Clear our
          // optimistic set when that happens so we don't leak memory across
          // long-running boards.
          const visibleIds = new Set(next.map((p) => p.reqId))
          for (const id of Array.from(optimisticallyResolved)) {
            if (!visibleIds.has(id)) optimisticallyResolved.delete(id)
          }
          if (!sameRequests(pendingRequests, next)) {
            pendingRequests = next
            // Don't overwrite a final done/error state if the run already
            // resolved between polls.
            if (runPanelState.kind === "running" || runPanelState.kind === "input") {
              runPanelState = {
                kind: next.length > 0 ? "input" : "running",
              }
              drawRunPanel()
            }
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return
        // Transient (network, etc.) — try again next tick.
      }
      await sleep(500)
    }
  }

  // Per-run progress tail. Polls /api/workflow/active-runs to discover the
  // current run's id (the run-handler holds the run-POST open until exit,
  // so the runId only arrives in the response after everything is done —
  // we need a sideband to know what to tail). Once we have a runId, fetch
  // its stdout.log on the same cadence and surface the last N lines.
  const pollProgress = async (workspaceId: string, signal: AbortSignal) => {
    const tailLines = 40
    while (!signal.aborted) {
      try {
        if (!activeRunId) {
          const r = await fetch(
            `/api/workflow/active-runs?workspaceId=${encodeURIComponent(workspaceId)}`,
            { signal },
          )
          if (r.ok) {
            const j = (await r.json()) as { runs?: Array<{ runId: string }> }
            if (j.runs && j.runs.length > 0) {
              activeRunId = j.runs[0].runId
            }
          }
        }
        if (activeRunId) {
          // workspaceId already starts with "workflows/" (e.g.
          // "workflows/example-ask-ticket") so the URL needs ONE leading
          // slash, not "/workflows/" — otherwise it doubles up to
          // /workflows/workflows/... and 404s back as empty 200.
          const logUrl = `/${workspaceId}.runtime/runs/${activeRunId}/stdout.log`
          const r = await fetch(logUrl, { signal })
          if (r.ok) {
            const text = await r.text()
            // Filter out the __RUN_OK__ / __RUN_ERR__ sentinels which are
            // bookkeeping noise, not progress signal.
            const filtered = text
              .split("\n")
              .filter((l) => l && !l.startsWith("__RUN_"))
              .slice(-tailLines)
              .join("\n")
            if (filtered !== progressTail) {
              progressTail = filtered
              if (runPanelState.kind === "running" || runPanelState.kind === "input") {
                drawRunPanel()
              }
            }
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return
      }
      await sleep(1000)
    }
  }

  const submitInput = (reqId: string, value: string | number | boolean) => {
    const req = pendingRequests.find((p) => p.reqId === reqId)
    if (!req) return
    optimisticallyResolved.add(reqId)
    pendingRequests = pendingRequests.filter((p) => p.reqId !== reqId)
    if (runPanelState.kind === "input" || runPanelState.kind === "running") {
      runPanelState = { kind: pendingRequests.length > 0 ? "input" : "running" }
      drawRunPanel()
    }
    const workspaceId = ctx.capabilities.workspaceId
    if (!workspaceId) return
    void fetch("/api/workflow/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, runId: req.runId, reqId, value }),
    }).then(async (r) => {
      if (!r.ok) console.error("[workflow-board] /api/workflow/input failed", await r.text())
    }).catch((e) => console.error("[workflow-board] /api/workflow/input error", e))
  }

  const showCodePanel = (title: string, source: string) => {
    const existing = wrap.querySelector(".workflow-board__code-overlay")
    if (existing) existing.remove()
    const overlay = document.createElement("div")
    overlay.className = "workflow-board__code-overlay"
    overlay.innerHTML = `
      <div class="workflow-board__code-panel">
        <div class="workflow-board__code-header">
          <strong></strong>
          <button type="button" class="workflow-board__code-copy">Copy</button>
          <button type="button" class="workflow-board__code-close">Close</button>
        </div>
        <pre class="workflow-board__code-body"></pre>
      </div>
    `
    overlay.querySelector("strong")!.textContent = title
    overlay.querySelector(".workflow-board__code-body")!.textContent = source
    overlay
      .querySelector<HTMLButtonElement>(".workflow-board__code-copy")!
      .addEventListener("click", () => {
        void navigator.clipboard.writeText(source)
      })
    overlay
      .querySelector<HTMLButtonElement>(".workflow-board__code-close")!
      .addEventListener("click", () => overlay.remove())
    // No click-outside-to-dismiss now that the panel is inline; the
    // Close button is the only way to remove it. Same in drawRunPanel.
    wrap.appendChild(overlay)
  }

  // Rebuild the Run overlay from runPanelState + pendingRequests. Called
  // when the state changes (run started, prompts appeared/were submitted,
  // run finished). Preserves any text the user has typed into still-visible
  // input fields by reusing values from the prior DOM.
  const drawRunPanel = () => {
    if (runPanelState.kind === "idle") {
      const existing = wrap.querySelector(".workflow-board__code-overlay")
      if (existing) existing.remove()
      return
    }
    // Preserve focus and typed values across redraws.
    const prior = wrap.querySelector(".workflow-board__code-overlay")
    const carriedValues: Record<string, string> = {}
    let focusedReqId: string | null = null
    if (prior) {
      prior
        .querySelectorAll<HTMLInputElement | HTMLSelectElement>(".workflow-board__input-field")
        .forEach((el) => {
          const id = el.dataset.reqId
          if (!id) return
          carriedValues[id] = el instanceof HTMLInputElement && el.type === "checkbox"
            ? String(el.checked)
            : el.value
          if (document.activeElement === el) focusedReqId = id
        })
      prior.remove()
    }
    const overlay = document.createElement("div")
    overlay.className = "workflow-board__code-overlay"
    const panel = document.createElement("div")
    panel.className = "workflow-board__code-panel"
    overlay.appendChild(panel)

    const header = document.createElement("div")
    header.className = "workflow-board__code-header"
    const titleEl = document.createElement("strong")
    titleEl.textContent =
      runPanelState.kind === "running"
        ? "Running…"
        : runPanelState.kind === "input"
          ? `Awaiting input (${pendingRequests.length})`
          : runPanelState.kind === "done"
            ? ((runPanelState.payload as { ok?: boolean } | null)?.ok
                ? "Run succeeded"
                : "Run completed with errors")
            : "Run failed"
    header.appendChild(titleEl)

    // Close button — always available so an aborted/error state can be
    // dismissed without restarting. We don't try to cancel an in-flight
    // run from here (no abort plumbing yet); the panel just closes.
    const closeBtn = document.createElement("button")
    closeBtn.type = "button"
    closeBtn.className = "workflow-board__code-close"
    closeBtn.textContent = "Close"
    closeBtn.addEventListener("click", () => {
      runPanelState = { kind: "idle" }
      drawRunPanel()
    })
    header.appendChild(closeBtn)
    panel.appendChild(header)

    // Progress tail — shown while running OR awaiting input, so the user
    // can see what the workflow is doing even when the foreground UI is
    // a Gradio-style form. Hidden in done/error states because the
    // result-body pre block carries the full stdout/stderr anyway.
    if (
      progressTail &&
      (runPanelState.kind === "running" || runPanelState.kind === "input")
    ) {
      const progressEl = document.createElement("pre")
      progressEl.className = "workflow-board__progress-tail"
      progressEl.textContent = progressTail
      panel.appendChild(progressEl)
    }

    // Body: either the input form (input/running with pending) or a pre block.
    if (runPanelState.kind === "input" && pendingRequests.length > 0) {
      const formArea = document.createElement("div")
      formArea.className = "workflow-board__input-area"
      for (const req of pendingRequests) {
        formArea.appendChild(
          buildInputForm(req, carriedValues[req.reqId], submitInput),
        )
      }
      panel.appendChild(formArea)
      if (focusedReqId) {
        const target = panel.querySelector<HTMLElement>(
          `.workflow-board__input-field[data-req-id="${CSS.escape(focusedReqId)}"]`,
        )
        target?.focus()
      } else {
        // Focus the first field of the first pending request — gives the
        // browser instant typing-readiness so the user can answer the
        // prompt without first reaching for the mouse.
        const first = panel.querySelector<HTMLElement>(".workflow-board__input-field")
        first?.focus()
      }
    } else {
      const pre = document.createElement("pre")
      pre.className = "workflow-board__code-body"
      pre.textContent = runPanelBodyText(runPanelState)
      panel.appendChild(pre)
    }

    wrap.appendChild(overlay)
  }

  const root: Root = createRoot(canvasHost)
  const renderRoot = () => {
    try {
      root.render(
        React.createElement(BoardCanvas, {
          data: projectToCanvas(currentData),
          mode: ctx.mode,
          onChange: handleChange,
          palette: WORKFLOW_PALETTE,
          extraToolbarRight: toolbarRightCluster(handleExport, handleRun, running),
        } as unknown as React.ComponentProps<typeof BoardCanvas>),
      )
    } catch (e) {
      const err = document.createElement("div")
      err.className = "quartz-widget__error"
      err.textContent = `Workflow canvas threw: ${(e as Error).message}`
      canvasHost.innerHTML = ""
      canvasHost.appendChild(err)
      console.error("[workflow-board] render error", e)
    }
  }
  renderRoot()

  // Auto-restore the most recent run's panel on mount. The previous run's
  // result.json + stdout.log are persisted on disk under runs/<id>/, so
  // after navigate-away / refresh / new tab we can re-show the same
  // inline panel state the user last saw. Skips if there's no prior run
  // or if the latest one is still in flight (the live-tail path will
  // pick that up via active-runs polling once Run is clicked again).
  ;(async () => {
    const workspaceId = ctx.capabilities.workspaceId
    if (!workspaceId) return
    try {
      const r = await fetch(`/api/workflow/runs?workspaceId=${encodeURIComponent(workspaceId)}&limit=1`)
      if (!r.ok) return
      const j = (await r.json()) as {
        runs?: Array<{
          runId: string
          status: string
          exitCode?: number
          result?: { ok?: boolean; result?: unknown; error?: { message?: string } }
          startedAt?: string
        }>
      }
      const latest = j.runs?.[0]
      if (!latest || latest.status === "running") return
      if (runPanelState.kind !== "idle") return
      // Also fetch the run's stdout.log so the restored panel can show
      // the same per-step trace the live tail would have shown. Best-
      // effort — if the log is missing the result still restores.
      let stdoutText = ""
      try {
        const lr = await fetch(`/${workspaceId}.runtime/runs/${latest.runId}/stdout.log`)
        if (lr.ok) stdoutText = await lr.text()
      } catch {}
      // The run-handler's response shape is what runPanelBodyText expects;
      // construct an equivalent from /runs data so the existing renderer
      // works without a branch.
      const ok = latest.result?.ok === true
      runPanelState = {
        kind: "done",
        payload: {
          ok,
          runId: latest.runId,
          runDir: `${workspaceId}.runtime/runs/${latest.runId}`,
          exitCode: latest.exitCode ?? (ok ? 0 : 1),
          timedOut: false,
          stdout: stdoutText.replace(/^__RUN_(OK|ERR)__$/gm, "").trim(),
          stderr: "",
          result: latest.result?.result ?? latest.result,
        },
      }
      drawRunPanel()
    } catch {
      // Best-effort; failing to restore shouldn't break the widget.
    }
  })()

  return () => {
    root.unmount()
    ctx.el.innerHTML = ""
  }
}
