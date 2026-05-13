import micromorph from "micromorph"
import { FullSlug, RelativeURL, getFullSlug, normalizeRelativeURLs } from "../../util/path"
import { fetchCanonical } from "./util"

// adapted from `micromorph`
// https://github.com/natemoo-re/micromorph
const NODE_TYPE_ELEMENT = 1
let announcer = document.createElement("route-announcer")
const isElement = (target: EventTarget | null): target is Element =>
  (target as Node)?.nodeType === NODE_TYPE_ELEMENT
const isLocalUrl = (href: string) => {
  try {
    const url = new URL(href)
    if (window.location.origin === url.origin) {
      return true
    }
  } catch (e) {}
  return false
}

const isSamePage = (url: URL): boolean => {
  const sameOrigin = url.origin === window.location.origin
  const samePath = url.pathname === window.location.pathname
  return sameOrigin && samePath
}

const getOpts = ({ target }: Event): { url: URL; scroll?: boolean } | undefined => {
  if (!isElement(target)) return
  if (target.attributes.getNamedItem("target")?.value === "_blank") return
  const a = target.closest("a")
  if (!a) return
  if ("routerIgnore" in a.dataset) return
  const { href } = a
  if (!isLocalUrl(href)) return
  return { url: new URL(href), scroll: "routerNoscroll" in a.dataset ? false : undefined }
}

function notifyNav(url: FullSlug) {
  const event: CustomEventMap["nav"] = new CustomEvent("nav", { detail: { url } })
  document.dispatchEvent(event)
}

const cleanupFns: Set<(...args: any[]) => void> = new Set()
window.addCleanup = (fn) => cleanupFns.add(fn)

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
const DEFAULT_AI_AGENT = "codex"
const DEFAULT_CODEX_MODEL = "gpt-5.4-mini"
const DEFAULT_AI_DIFFICULTY = "medium"

function defaultModelForAgent(agent: string): string {
  return agent === DEFAULT_AI_AGENT ? DEFAULT_CODEX_MODEL : ""
}

function readAiContext(from: Element | null): AiContext {
  const context: AiContext = {}
  if (!from) return context
  for (const attr of aiContextAttrs) {
    const value = from.getAttribute(attr)
    if (value !== null) context[attr] = value
  }
  return context
}

function aiSessionSignature(context: AiContext): string {
  return JSON.stringify([
    context["data-bridge-origin"] || "",
    context["data-role-id"] || "",
    context["data-agent"] || DEFAULT_AI_AGENT,
    context["data-cwd"] || "",
    context["data-model"] || defaultModelForAgent(context["data-agent"] || DEFAULT_AI_AGENT),
    context["data-difficulty"] || DEFAULT_AI_DIFFICULTY,
  ])
}

function clearAiSessionForContextChange(sidebar: Element | null) {
  if (!sidebar) return
  sidebar.removeAttribute("data-session-id")
  sidebar.removeAttribute("data-session-binding")
  sidebar.removeAttribute("data-workspace-context-sent")
  const terminal = sidebar.querySelector<HTMLElement>("[data-ai-terminal]")
  if (terminal) {
    terminal.replaceChildren()
    const placeholder = document.createElement("span")
    placeholder.textContent =
      "PTY session changes with this workspace. Start or resume the workspace PTY."
    terminal.appendChild(placeholder)
  }
}

function writeAiContext(to: Element | null, context: AiContext) {
  if (!to) return
  const previousSignature = aiSessionSignature(readAiContext(to))
  const keepSelectedAgent = to instanceof HTMLElement && to.dataset.agentLocked === "1"
  for (const attr of aiContextAttrs) {
    if (attr === "data-agent" && keepSelectedAgent) continue
    const value = context[attr]
    if (value === undefined) to.removeAttribute(attr)
    else to.setAttribute(attr, value)
  }
  const nextSignature = aiSessionSignature(readAiContext(to))
  if (previousSignature !== nextSignature) clearAiSessionForContextChange(to)
}

// For every [data-persist] element in the live DOM that has children
// (added at runtime — e.g. PDF.js canvases inside .pdf-viewer), find
// the matching empty placeholder in `nextBody` and inject a deep
// CLONE of the live subtree. The clone has the same structure but no
// runtime side-state (canvas pixels, audio playback position, etc.).
//
// micromorph compares structure/attributes only — so it sees the
// pre-populated next slot as identical to the live one and emits NO
// patches for that subtree. The live painted canvases never get
// removed → no flicker.
//
// Matching priority: id, then data-pdf-src, then data-persist-key.
// (Add more keys here when new persist-needing components show up.)
function preservePersistedSubtrees(curRoot: HTMLElement, nextRoot: HTMLElement) {
  const persisted = curRoot.querySelectorAll<HTMLElement>("[data-persist]")
  for (const cur of Array.from(persisted)) {
    if (cur.children.length === 0) continue
    let match: Element | null = null
    if (cur.id) {
      try { match = nextRoot.querySelector(`#${CSS.escape(cur.id)}`) } catch {}
    }
    if (!match) {
      const pdfSrc = cur.getAttribute("data-pdf-src")
      if (pdfSrc) {
        try { match = nextRoot.querySelector(`[data-pdf-src="${CSS.escape(pdfSrc)}"]`) } catch {}
      }
    }
    if (!match) {
      const key = cur.getAttribute("data-persist-key")
      if (key) {
        try { match = nextRoot.querySelector(`[data-persist-key="${CSS.escape(key)}"]`) } catch {}
      }
    }
    if (!match || match.children.length > 0) continue
    for (const child of Array.from(cur.children)) {
      match.appendChild(child.cloneNode(true))
    }
  }
}

function preserveAiGlobalHost(nextBody: Document["body"]) {
  const currentPanel = document.querySelector<HTMLElement>(".assistant-panel[data-ai-global-host]")
  const incomingPanel = nextBody.querySelector<HTMLElement>(".assistant-panel")
  if (!incomingPanel) return

  incomingPanel.dataset.aiGlobalHost = ""
  incomingPanel.dataset.persist = ""

  if (!currentPanel || currentPanel === incomingPanel) return

  const nextContext = readAiContext(incomingPanel.querySelector<HTMLElement>(".ai-sidebar"))
  ;(window as Window & { __quartzAiPendingContext?: AiContext }).__quartzAiPendingContext =
    nextContext
  currentPanel.dataset.aiGlobalHost = ""
  currentPanel.dataset.persist = ""
  const stableClone = currentPanel.cloneNode(true) as HTMLElement
  writeAiContext(stableClone.querySelector<HTMLElement>(".ai-sidebar"), nextContext)
  incomingPanel.replaceWith(stableClone)
}

function startLoading() {
  const loadingBar = document.createElement("div")
  loadingBar.className = "navigation-progress"
  loadingBar.style.width = "0"
  if (!document.body.contains(loadingBar)) {
    document.body.appendChild(loadingBar)
  }

  setTimeout(() => {
    loadingBar.style.width = "80%"
  }, 100)
}

let isNavigating = false
let p: DOMParser
async function _navigate(url: URL, isBack: boolean = false) {
  isNavigating = true
  startLoading()
  p = p || new DOMParser()
  const contents = await fetchCanonical(url)
    .then((res) => {
      const contentType = res.headers.get("content-type")
      if (contentType?.startsWith("text/html")) {
        return res.text()
      } else {
        window.location.assign(url)
      }
    })
    .catch(() => {
      window.location.assign(url)
    })

  if (!contents) return

  // notify about to nav
  const event: CustomEventMap["prenav"] = new CustomEvent("prenav", { detail: {} })
  document.dispatchEvent(event)

  // cleanup old
  cleanupFns.forEach((fn) => fn())
  cleanupFns.clear()

  const html = p.parseFromString(contents, "text/html")
  normalizeRelativeURLs(html, url)
  preserveAiGlobalHost(html.body)

  let title = html.querySelector("title")?.textContent
  if (title) {
    document.title = title
  } else {
    const h1 = document.querySelector("h1")
    title = h1?.innerText ?? h1?.textContent ?? url.pathname
  }
  if (announcer.textContent !== title) {
    announcer.textContent = title
  }
  announcer.dataset.persist = ""
  html.body.appendChild(announcer)

  // morph body — but first hydrate any [data-persist] subtrees in the
  // new HTML with cloned structure from the live DOM, so micromorph
  // sees identical children at those positions and skips touching
  // them. micromorph compares attributes/structure, not pixel data,
  // so the cloned (blank) canvas matches the live (painted) canvas;
  // the live one survives the morph untouched.
  preservePersistedSubtrees(document.body, html.body)
  await micromorph(document.body, html.body)

  // scroll into place and add history
  if (!isBack) {
    if (url.hash) {
      const el = document.getElementById(decodeURIComponent(url.hash.substring(1)))
      el?.scrollIntoView()
    } else {
      window.scrollTo({ top: 0 })
    }
  }

  // now, patch head, re-executing scripts
  const elementsToRemove = document.head.querySelectorAll(":not([data-persist])")
  elementsToRemove.forEach((el) => el.remove())
  const elementsToAdd = html.head.querySelectorAll(":not([data-persist])")
  elementsToAdd.forEach((el) => document.head.appendChild(el))

  // delay setting the url until now
  // at this point everything is loaded so changing the url should resolve to the correct addresses
  if (!isBack) {
    history.pushState({}, "", url)
  }

  notifyNav(getFullSlug(window))
  delete announcer.dataset.persist
}

async function navigate(url: URL, isBack: boolean = false) {
  if (isNavigating) return
  isNavigating = true
  try {
    await _navigate(url, isBack)
  } catch (e) {
    console.error(e)
    window.location.assign(url)
  } finally {
    isNavigating = false
  }
}

window.spaNavigate = navigate

function createRouter() {
  if (typeof window !== "undefined") {
    window.addEventListener("click", async (event) => {
      const { url } = getOpts(event) ?? {}
      // dont hijack behaviour, just let browser act normally
      if (!url || event.ctrlKey || event.metaKey) return
      event.preventDefault()

      if (isSamePage(url) && url.hash) {
        const el = document.getElementById(decodeURIComponent(url.hash.substring(1)))
        el?.scrollIntoView()
        history.pushState({}, "", url)
        return
      }

      navigate(url, false)
    })

    window.addEventListener("popstate", (event) => {
      const { url } = getOpts(event) ?? {}
      if (window.location.hash && window.location.pathname === url?.pathname) return
      navigate(new URL(window.location.toString()), true)
      return
    })
  }

  return new (class Router {
    go(pathname: RelativeURL) {
      const url = new URL(pathname, window.location.toString())
      return navigate(url, false)
    }

    back() {
      return window.history.back()
    }

    forward() {
      return window.history.forward()
    }
  })()
}

createRouter()
notifyNav(getFullSlug(window))

if (!customElements.get("route-announcer")) {
  const attrs = {
    "aria-live": "assertive",
    "aria-atomic": "true",
    style:
      "position: absolute; left: 0; top: 0; clip: rect(0 0 0 0); clip-path: inset(50%); overflow: hidden; white-space: nowrap; width: 1px; height: 1px",
  }

  customElements.define(
    "route-announcer",
    class RouteAnnouncer extends HTMLElement {
      constructor() {
        super()
      }
      connectedCallback() {
        for (const [key, value] of Object.entries(attrs)) {
          this.setAttribute(key, value)
        }
      }
    },
  )
}
