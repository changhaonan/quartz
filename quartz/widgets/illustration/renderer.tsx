import type { WidgetMountContext } from "../types"
import type { IllustrationBoardData } from "./schema"

// The illustration widget delegates rendering to the bridge canvas
// (claude_pty/client/src/blueprint/canvas/), already tuned over many
// iterations. Quartz's role is data-source-of-truth (the JSON file in
// Git) and write-coordination (M6 file-runtime API). The canvas is
// mounted via iframe; the bridge resolves `file=` against its content
// root, reads the JSON, renders, and routes mutations back through
// the same write API.
//
// Bridge contract (to be implemented on the bridge side):
//   GET  /bridge/illustration?file=<content-relative-path>
//                           &workspaceId=<id>
//                           &readonly=<0|1>
//   - Loads the file, mounts the existing canvas around it.
//   - In live mode, drag-to-save calls bridge's POST file-runtime
//     write API (which we already use directly in client.ts).

const DEFAULT_BRIDGE_PATH = "/bridge/illustration"
const DEFAULT_HEIGHT = "560px"

export function mountIllustrationBoard(
  ctx: WidgetMountContext<IllustrationBoardData>,
): () => void {
  const url = buildIframeUrl(ctx)
  const iframe = document.createElement("iframe")
  iframe.src = url
  iframe.title = "Illustration board"
  iframe.loading = "lazy"
  iframe.referrerPolicy = "no-referrer"
  iframe.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-forms allow-pointer-lock",
  )
  iframe.style.display = "block"
  iframe.style.width = "100%"
  iframe.style.height = ctx.el.style.minHeight || DEFAULT_HEIGHT
  iframe.style.border = "0"
  iframe.style.background = "var(--light)"

  const status = document.createElement("div")
  status.className = "illustration-board-frame__status"
  status.textContent = `${ctx.mode === "live" ? "Live" : "Read-only"} · ${ctx.path}`

  const wrap = document.createElement("div")
  wrap.className = "illustration-board-frame"
  wrap.dataset.mode = ctx.mode
  wrap.appendChild(status)
  wrap.appendChild(iframe)

  ctx.el.innerHTML = ""
  ctx.el.appendChild(wrap)

  return () => {
    ctx.el.innerHTML = ""
  }
}

function buildIframeUrl(ctx: WidgetMountContext<IllustrationBoardData>): string {
  const origin = ctx.capabilities.bridgeOrigin.replace(/\/$/, "")
  const url = new URL(DEFAULT_BRIDGE_PATH, origin)
  url.searchParams.set("file", ctx.path)
  if (ctx.capabilities.workspaceId) {
    url.searchParams.set("workspaceId", ctx.capabilities.workspaceId)
  }
  url.searchParams.set("readonly", ctx.mode === "live" ? "0" : "1")
  url.searchParams.set("embed", "1")
  return url.toString()
}
