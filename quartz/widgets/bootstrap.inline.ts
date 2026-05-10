import { getWidget } from "./registry"
import { fetchWidgetData, writeWidget } from "./client"
import "./index"
import type {
  WidgetCapabilities,
  WidgetDispose,
  WidgetMode,
  WidgetMountContext,
} from "./types"

const TYPE_ATTR = "data-widget-type"
const SRC_ATTR = "data-widget-src"
const MODE_ATTR = "data-widget-mode"
const VERSION_ATTR = "data-widget-version"
const BRIDGE_ATTR = "data-bridge-origin"
const WORKSPACE_ATTR = "data-workspace-id"
const PATH_ATTR = "data-widget-path"
const STATE_ATTR = "data-widget-state"

const mounted = new WeakMap<HTMLElement, WidgetDispose>()

function setError(el: HTMLElement, message: string) {
  el.setAttribute(STATE_ATTR, "error")
  el.innerHTML = ""
  const err = document.createElement("div")
  err.className = "quartz-widget__error"
  err.textContent = message
  el.appendChild(err)
}

function setLoading(el: HTMLElement) {
  if (el.getAttribute(STATE_ATTR) === "ready") return
  el.setAttribute(STATE_ATTR, "loading")
  if (!el.firstChild) {
    const loading = document.createElement("div")
    loading.className = "quartz-widget__loading"
    loading.textContent = "Loading widget..."
    el.appendChild(loading)
  }
}

async function loadAndMount(el: HTMLElement) {
  if (mounted.has(el)) return

  const type = el.getAttribute(TYPE_ATTR)
  const src = el.getAttribute(SRC_ATTR)
  if (!type || !src) {
    setError(el, "Widget placeholder missing type or src attribute.")
    return
  }

  const widget = getWidget(type)
  if (!widget) {
    setError(el, `Unknown widget type: ${type}`)
    return
  }

  const declaredVersion = Number(el.getAttribute(VERSION_ATTR) ?? widget.schemaVersion)
  if (declaredVersion !== widget.schemaVersion) {
    setError(
      el,
      `Schema version mismatch for ${type}: page expects v${declaredVersion}, ` +
        `renderer is v${widget.schemaVersion}.`,
    )
    return
  }

  setLoading(el)

  let raw: unknown
  let version: string | null = null
  try {
    const fetched = await fetchWidgetData(src)
    raw = fetched.data
    version = fetched.version
  } catch (e) {
    setError(el, `Failed to load data: ${(e as Error).message}`)
    return
  }

  const parseResult = widget.schema.safeParse(raw)
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")
    setError(el, `Schema validation failed: ${issues}`)
    return
  }

  const mode = (el.getAttribute(MODE_ATTR) ?? "readonly") as WidgetMode
  const bridgeOrigin = el.getAttribute(BRIDGE_ATTR) ?? "http://127.0.0.1:3210"
  const workspaceId = el.getAttribute(WORKSPACE_ATTR) || null
  const widgetPath = el.getAttribute(PATH_ATTR) ?? src

  const capabilities: WidgetCapabilities = {
    canWrite: mode === "live" && workspaceId !== null,
    bridgeOrigin,
    workspaceId,
  }

  const refresh = async () => {
    const dispose = mounted.get(el)
    if (dispose) {
      try {
        dispose()
      } catch (err) {
        console.warn("[widget] dispose during refresh failed", err)
      }
      mounted.delete(el)
    }
    el.innerHTML = ""
    el.removeAttribute(STATE_ATTR)
    await loadAndMount(el)
  }

  const ctx: WidgetMountContext<unknown> = {
    el,
    data: parseResult.data,
    mode,
    capabilities,
    write: async (req) => {
      if (!workspaceId) {
        return {
          ok: false,
          error: { code: "no_workspace", message: "Widget is not bound to a workspace" },
        }
      }
      const result = await writeWidget(bridgeOrigin, {
        workspaceId,
        path: widgetPath,
        patch: req.patch,
        ifVersion: req.ifVersion ?? version ?? undefined,
      })
      if (result.ok && typeof result.newVersion === "string") {
        version = result.newVersion
      }
      return result
    },
    refresh,
  }

  el.innerHTML = ""
  el.setAttribute(STATE_ATTR, "ready")
  let dispose: WidgetDispose | void
  try {
    dispose = widget.mount(ctx)
  } catch (e) {
    setError(el, `Renderer threw: ${(e as Error).message}`)
    return
  }
  mounted.set(el, dispose ?? (() => {}))
}

function mountAll() {
  document
    .querySelectorAll<HTMLElement>(`[${TYPE_ATTR}]`)
    .forEach((el) => void loadAndMount(el))
}

function disposeAll() {
  document.querySelectorAll<HTMLElement>(`[${TYPE_ATTR}]`).forEach((el) => {
    const d = mounted.get(el)
    if (d) {
      try {
        d()
      } catch (err) {
        console.warn("[widget] dispose error", err)
      }
      mounted.delete(el)
    }
  })
}

document.addEventListener("nav", () => {
  mountAll()
  window.addCleanup(disposeAll)
})
