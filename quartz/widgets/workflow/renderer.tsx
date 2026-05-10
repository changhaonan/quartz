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
  return {
    id: `workflow-node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: entry.type as WorkflowNode["kind"],
    visual: entry.visual as WorkflowNode["visual"],
    op: entry.op,
    params: {},
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
  const handleRun = async () => {
    if (running) return
    if (!ctx.capabilities.workspaceId) {
      showRunPanel("error", "No workspaceId — set frontmatter `workspaceId: <id>` on the page.")
      return
    }
    const gen = generateWorkflowSource(currentData, { entryName: "workflow" })
    if (gen.warnings.length > 0) {
      console.warn("[workflow-board] codegen warnings:", gen.warnings)
    }
    running = true
    renderRoot()
    showRunPanel("running", "Running workflow…")
    let res: Response
    try {
      res = await fetch("/api/workflow/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: ctx.capabilities.workspaceId,
          source: gen.source,
          entryName: "workflow",
          entryParams: [],
        }),
      })
    } catch (e) {
      running = false
      renderRoot()
      showRunPanel("error", `Network error: ${(e as Error).message}`)
      return
    }
    let body: unknown = null
    try {
      body = await res.json()
    } catch {}
    running = false
    renderRoot()
    if (!res.ok) {
      showRunPanel("error", JSON.stringify(body, null, 2))
      return
    }
    showRunPanel("done", body)
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
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove()
    })
    wrap.appendChild(overlay)
  }

  const showRunPanel = (
    kind: "running" | "done" | "error",
    payload: unknown,
  ) => {
    const existing = wrap.querySelector(".workflow-board__code-overlay")
    if (existing) existing.remove()
    const overlay = document.createElement("div")
    overlay.className = "workflow-board__code-overlay"
    let bodyText = ""
    let title = ""
    if (kind === "running") {
      title = "Running…"
      bodyText = typeof payload === "string" ? payload : ""
    } else if (kind === "error") {
      title = "Run failed"
      bodyText = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)
    } else {
      const p = payload as {
        ok?: boolean
        runId?: string
        runDir?: string
        exitCode?: number
        timedOut?: boolean
        stdout?: string
        stderr?: string
        result?: unknown
      } | null
      const sections: string[] = []
      sections.push(`runId: ${p?.runId ?? "?"}`)
      sections.push(`runDir: ${p?.runDir ?? "?"}`)
      sections.push(`exitCode: ${p?.exitCode ?? "?"}${p?.timedOut ? " (timed out)" : ""}`)
      if (p?.result !== undefined) {
        sections.push("")
        sections.push("--- result ---")
        sections.push(typeof p.result === "string" ? p.result : JSON.stringify(p.result, null, 2))
      }
      if (p?.stdout) {
        sections.push("")
        sections.push("--- stdout ---")
        sections.push(p.stdout)
      }
      if (p?.stderr) {
        sections.push("")
        sections.push("--- stderr ---")
        sections.push(p.stderr)
      }
      title = p?.ok ? "Run succeeded" : "Run completed with errors"
      bodyText = sections.join("\n")
    }
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
    overlay.querySelector(".workflow-board__code-body")!.textContent = bodyText
    overlay
      .querySelector<HTMLButtonElement>(".workflow-board__code-copy")!
      .addEventListener("click", () => {
        void navigator.clipboard.writeText(bodyText)
      })
    overlay
      .querySelector<HTMLButtonElement>(".workflow-board__code-close")!
      .addEventListener("click", () => overlay.remove())
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove()
    })
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

  return () => {
    root.unmount()
    ctx.el.innerHTML = ""
  }
}
