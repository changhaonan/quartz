import React from "react"
import { createRoot, type Root } from "react-dom/client"
import type { WidgetMountContext } from "../types"
import type { IllustrationBoardData } from "./schema"
import IllustrationCanvas from "./canvas/IllustrationCanvas"

interface NodeMoveEvent {
  id: string
  index: number
  x: number
  y: number
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
    ctx.mode === "live" ? "Drag nodes to reposition" : "Read-only"
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
        ctx.mode === "live" ? "Drag nodes to reposition" : "Read-only"
    }
  }

  const handleNodeMove = async (event: NodeMoveEvent) => {
    if (saving) return
    if (!ctx.capabilities.canWrite) return
    const node = currentData.nodes[event.index]
    if (!node) return
    const oldX = node.x
    const oldY = node.y
    if (oldX === event.x && oldY === event.y) return

    saving = true
    setStatus("saving")
    currentData = {
      ...currentData,
      nodes: currentData.nodes.map((n, i) =>
        i === event.index ? { ...n, x: event.x, y: event.y } : n,
      ),
    }
    renderRoot()
    const result = await ctx.write({
      patch: [
        { op: "replace", path: `/nodes/${event.index}/x`, value: event.x },
        { op: "replace", path: `/nodes/${event.index}/y`, value: event.y },
      ],
    })
    saving = false
    if (result.ok) {
      setStatus("saved")
      window.setTimeout(() => setStatus("idle"), 1500)
    } else {
      setStatus("error", result.error?.message)
      currentData = {
        ...currentData,
        nodes: currentData.nodes.map((n, i) =>
          i === event.index ? { ...n, x: oldX, y: oldY } : n,
        ),
      }
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
          onNodeMove: handleNodeMove,
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
