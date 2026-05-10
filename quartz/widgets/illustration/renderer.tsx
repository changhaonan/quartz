import React from "react"
import { createRoot, type Root } from "react-dom/client"
import type { JsonPatchOp, WidgetMountContext } from "../types"
import type { IllustrationBoardData } from "./schema"
import IllustrationCanvas from "./canvas/IllustrationCanvas"

function decodeJsonPointer(pointer: string): (string | number)[] {
  if (!pointer || pointer === "/") return []
  if (!pointer.startsWith("/")) {
    throw new Error(`json pointer must start with /: ${pointer}`)
  }
  return pointer
    .slice(1)
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"))
}

function applyPatchLocal(doc: unknown, ops: JsonPatchOp[]): unknown {
  // Mutates a deep clone and returns the new root. Mirrors the server-side
  // applier in handlers.js so optimistic UI matches the eventual on-disk state.
  const root: { v: unknown } = { v: structuredClone(doc) }
  for (const op of ops) {
    const segs = decodeJsonPointer(op.path)
    const last = segs.pop() as string | undefined
    let parent: { v: unknown } | unknown = root
    let key: string | number = "v"
    for (const seg of segs) {
        const next = (parent as Record<string | number, unknown>)[key]
      if (next === null || typeof next !== "object") {
        throw new Error(`json pointer traverses non-object: ${op.path}`)
      }
      parent = next
      key = Array.isArray(parent) ? Number(seg) : seg
    }
    // @ts-expect-error: dynamic keying.
    const target = parent[key]
    if (target === null || typeof target !== "object") {
      throw new Error(`json pointer parent is not an object/array: ${op.path}`)
    }
    const finalKey = Array.isArray(target)
      ? last === "-"
        ? target.length
        : Number(last)
      : (last as string)
    const targetRecord = target as Record<string | number, unknown>
    if (op.op === "replace") {
      targetRecord[finalKey] = (op as { value: unknown }).value
    } else if (op.op === "add") {
      if (Array.isArray(target)) {
        if (last === "-") target.push((op as { value: unknown }).value)
        else target.splice(Number(finalKey), 0, (op as { value: unknown }).value)
      } else {
        targetRecord[finalKey] = (op as { value: unknown }).value
      }
    } else if (op.op === "remove") {
      if (Array.isArray(target)) target.splice(Number(finalKey), 1)
      else delete targetRecord[finalKey]
    } else {
      throw new Error(`unsupported op: ${(op as { op: string }).op}`)
    }
  }
  return root.v
}

export function mountIllustrationBoard(
  ctx: WidgetMountContext<IllustrationBoardData>,
): () => void {
  if (!ctx.data) {
    ctx.el.innerHTML =
      '<div class="quartz-widget__error">Illustration data not loaded.</div>'
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
      ? "Drag · click to select · Del to delete · drag from a handle to connect"
      : "Read-only"
  chrome.appendChild(modeBadge)
  chrome.appendChild(status)

  const canvasHost = document.createElement("div")
  canvasHost.className = "illustration-board-frame__canvas"

  wrap.appendChild(chrome)
  wrap.appendChild(canvasHost)
  ctx.el.innerHTML = ""
  ctx.el.appendChild(wrap)

  let currentData: IllustrationBoardData = ctx.data
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
          ? "Drag · click to select · Del to delete · drag from a handle to connect"
          : "Read-only"
    }
  }

  const handleChange = async (ops: JsonPatchOp[]) => {
    if (!ops || ops.length === 0) return
    if (!ctx.capabilities.canWrite) return

    // Optimistic local update so the canvas reflects the change immediately.
    const previousData = currentData
    let nextData: IllustrationBoardData
    try {
      nextData = applyPatchLocal(currentData, ops) as IllustrationBoardData
    } catch (e) {
      setStatus("error", (e as Error).message)
      return
    }
    currentData = nextData
    renderRoot()

    // Coalesce: if a save is in flight, queue ops; the in-flight handler
    // will flush them when it finishes. Keeps the file consistent with the
    // optimistic local state without creating a stampede of writes.
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
      // Drain any ops that arrived during this save.
      if (pendingOps.length > 0) {
        const drained = pendingOps
        pendingOps = []
        void handleChange(drained)
      }
    } else {
      setStatus("error", result.error?.message)
      // Roll back optimistic update on failure.
      currentData = previousData
      pendingOps = []
      renderRoot()
    }
  }

  const root: Root = createRoot(canvasHost)
  const renderRoot = () => {
    try {
      root.render(
        React.createElement(IllustrationCanvas, {
          data: currentData,
          mode: ctx.mode,
          onChange: handleChange,
        } as React.ComponentProps<typeof IllustrationCanvas>),
      )
    } catch (e) {
      const err = document.createElement("div")
      err.className = "quartz-widget__error"
      err.textContent = `Illustration canvas threw: ${(e as Error).message}`
      canvasHost.innerHTML = ""
      canvasHost.appendChild(err)
      console.error("[illustration-board] render error", e)
    }
  }
  renderRoot()

  return () => {
    root.unmount()
    ctx.el.innerHTML = ""
  }
}
