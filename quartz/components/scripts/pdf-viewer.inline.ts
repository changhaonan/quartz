// Canvas-based PDF viewer using pdfjs-dist. Replaces the bare iframe
// embed so the rendered pages live in <canvas> elements — those don't
// reload when their wrapping block-card is moved around in the DOM
// (block reorder, micromorph soft-rebuild), which is the whole reason
// we're not using an iframe.
//
// Markup contract (emitted by ofm.ts for ![[*.pdf]]):
//   <figure class="pdf-embed" data-pdf-src="papers/foo.pdf" data-pdf-name="foo.pdf">
//     <div class="pdf-viewer" role="region" aria-label="PDF viewer"></div>
//     <figcaption class="pdf-embed__caption">
//       <a href="papers/foo.pdf" target="_blank">Open foo.pdf ↗</a>
//     </figcaption>
//   </figure>
//
// Pages render lazily via IntersectionObserver so a 50-page paper
// doesn't peg the main thread on first load.
//
// PER-PAGE BLOCKS: each .pdf-viewer__page is wrapped at runtime in
// a synthetic .block-card.block-card--pdf-page so the existing
// block-toolbar (⧉/💬/★) and ai-comment widget runtime treat each
// page as its own commentable block. data-block-id is derived from
// sha1(pdfSrc + "::p" + pageNum) so it survives reorders, page
// reloads, and re-mounts. The per-page card has a side annotation
// column (.block-card__annotations) so comments render to the right
// of the canvas instead of stacking below.
//
// EXPAND MODE: default is "expanded" — every page is wrapped + lazy
// rendered. The figure also gets a toggle so the user can collapse
// to page-1-only when scrolling past long papers; per-page
// annotations live in localStorage either way and reappear on
// re-expand.

import * as pdfjsLib from "pdfjs-dist"

type PdfDoc = Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>

// Resolve site root by piggy-backing on the existing favicon <link>:
// every Quartz page has rel="icon" pointing at <root>/static/icon.png,
// and the .href DOM property already gives us the resolved absolute
// URL — so this works for subpath deploys too without extra config.
function siteRootUrl(): string {
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (icon?.href) {
    // strip the trailing "static/icon.png" (or "static/icon.png?…")
    return icon.href.replace(/static\/[^/]+(\?.*)?$/, "")
  }
  return new URL("/", window.location.origin).toString()
}

function resolveWorkerUrl(): string {
  return siteRootUrl() + "static/pdf.worker.min.mjs"
}

// Resolve a content-relative path (e.g. "papers/distillation.pdf") to
// a fetchable absolute URL. data-pdf-src is the stable identity used
// for hashing — we don't want to bake the current page's path into
// it, so we do the resolution at runtime instead.
function resolveContentUrl(relPath: string): string {
  if (/^https?:\/\//i.test(relPath)) return relPath
  return siteRootUrl() + relPath.replace(/^\/+/, "")
}

// Stable block-id per (pdfSrc, pageNum). Mirrors the build-time
// hashText in plugins/transformers/blockPage.ts (sha-256, take 12
// hex chars) so the per-page id space doesn't collide with the
// figure-level id and is stable across reloads.
async function pageBlockId(pdfSrc: string, pageNum: number): Promise<string> {
  const enc = new TextEncoder().encode(`${pdfSrc}::p${pageNum}`)
  // SubtleCrypto is available in all browsers we target; fall back
  // to a non-crypto fold if it ever isn't (loaded over file://, etc.)
  if (window.crypto?.subtle) {
    const buf = await window.crypto.subtle.digest("SHA-256", enc)
    const bytes = new Uint8Array(buf).slice(0, 6)
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
  }
  // Cheap fallback: djb2 of the same string.
  let h = 5381
  for (const c of `${pdfSrc}::p${pageNum}`) h = ((h << 5) + h + c.charCodeAt(0)) | 0
  return (h >>> 0).toString(16).padStart(12, "0").slice(0, 12)
}

function makeToolbarBtn(action: string, title: string, label: string): HTMLButtonElement {
  const b = document.createElement("button")
  b.type = "button"
  b.className = "block-card__btn"
  b.setAttribute("data-block-action", action)
  b.title = title
  b.setAttribute("aria-label", title)
  b.textContent = label
  return b
}

let workerConfigured = false
function ensureWorker() {
  if (workerConfigured) return
  workerConfigured = true
  try {
    ;(pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
      resolveWorkerUrl()
  } catch {
    // ignore — pdfjs will throw on getDocument if this fails
  }
}

// Track which (host, src) pairs are already loaded so we don't tear
// down + re-render on every nav event when the host node persists.
const mounted = new WeakMap<HTMLElement, { src: string; pdf: PdfDoc; observer?: IntersectionObserver }>()
// Separate set for in-flight mounts — without this two concurrent
// scan() calls (DOMContentLoaded + nav, both firing on first paint)
// each see an empty `mounted` map and double-render every page.
const inFlight = new WeakMap<HTMLElement, string>()

async function mountViewer(host: HTMLElement, src: string): Promise<void> {
  const existing = mounted.get(host)
  if (existing && existing.src === src) {
    // "Already mounted" must also verify per-page cards still exist
    // in the DOM. After a block-reorder drop, micromorph diffs the
    // article and strips runtime-added .block-card--pdf-page nodes
    // (they're not in the morph target HTML), leaving the
    // .pdf-viewer host empty even though our WeakMap still believes
    // it's mounted. Without this check the user sees the PDF
    // container reposition but its per-page cards + comments vanish.
    if (host.querySelector(".block-card--pdf-page")) return
    existing.observer?.disconnect()
    mounted.delete(host)  // fall through to rebuild
  }
  if (inFlight.get(host) === src) return  // already mounting same src

  // Teardown any previous viewer on this host (different src).
  if (existing && mounted.get(host) === existing) {
    existing.observer?.disconnect()
    host.replaceChildren()
  }
  inFlight.set(host, src)

  host.replaceChildren()
  const status = document.createElement("div")
  status.className = "pdf-viewer__status"
  status.textContent = "Loading PDF…"
  host.appendChild(status)

  ensureWorker()
  try {
    const url = resolveContentUrl(src)
    // Point pdf.js at our vendored standard_fonts/ and cmaps/. Without
    // these, pdf.js falls back to metric-substitute fonts for any
    // glyphs it can't resolve from the PDF's embedded font — produces
    // wide letter-spacing on titles in older papers (Type 1 fonts
    // with custom encodings, e.g. the LSD-SLAM ECCV 2014 title).
    const fontsRoot = siteRootUrl() + "static/pdfjs/standard_fonts/"
    const cMapRoot = siteRootUrl() + "static/pdfjs/cmaps/"
    const loadingTask = pdfjsLib.getDocument({
      url,
      standardFontDataUrl: fontsRoot,
      cMapUrl: cMapRoot,
      cMapPacked: true,
    })
    const pdf = await loadingTask.promise

    host.replaceChildren()
    host.setAttribute("data-num-pages", String(pdf.numPages))

    // Pre-create a placeholder for each page (sized from the page's
    // intrinsic viewport so the scrollbar has the right shape before
    // any canvas is drawn).
    const firstPage = await pdf.getPage(1)
    const firstViewport = firstPage.getViewport({ scale: 1 })

    // Default mode = expanded; the figure can flip data-pdf-mode to
    // "collapsed" via the toggle button to hide all but page 1.
    const figure = host.closest<HTMLElement>("figure.pdf-embed")
    if (figure && !figure.dataset.pdfMode) figure.dataset.pdfMode = "expanded"

    for (let p = 1; p <= pdf.numPages; p++) {
      // Synthetic block-card per page so the existing toolbar +
      // ai-comment runtime treat each page as its own block.
      const card = document.createElement("div")
      const blockId = await pageBlockId(src, p)
      card.id = `block-pdf-${blockId}`
      card.className = "block-card block-card--pdf-page"
      card.setAttribute("data-block-id", blockId)
      card.setAttribute("data-pdf-src", src)
      card.setAttribute("data-pdf-page", String(p))

      const row = document.createElement("div")
      row.className = "pdf-viewer__page-row"

      const pageHost = document.createElement("div")
      pageHost.className = "pdf-viewer__page"
      pageHost.setAttribute("data-page-num", String(p))
      pageHost.style.aspectRatio = `${firstViewport.width} / ${firstViewport.height}`

      const slot = document.createElement("div")
      slot.className = "block-card__annotations"
      // Empty-state hint so users see the column exists before
      // they've added any comment. Cleared once the ai-comment
      // widget mounts content into the slot.
      const empty = document.createElement("div")
      empty.className = "block-card__annotations-empty"
      empty.textContent = "★ to ask Jarvis · 💬 to add your own note on this page"
      slot.appendChild(empty)

      row.appendChild(pageHost)
      row.appendChild(slot)
      card.appendChild(row)

      const toolbar = document.createElement("div")
      toolbar.className = "block-card__toolbar"
      toolbar.setAttribute("aria-hidden", "true")
      toolbar.appendChild(makeToolbarBtn("copy", "Copy this page's text", "⧉"))
      toolbar.appendChild(makeToolbarBtn("comment", "Add a note on this page", "💬"))
      toolbar.appendChild(makeToolbarBtn("jarvis-here", "Ask Jarvis to comment on this page", "★"))
      card.appendChild(toolbar)

      host.appendChild(card)
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const pageHost = entry.target as HTMLElement
          if (pageHost.dataset.rendered === "1" || pageHost.dataset.rendered === "rendering") continue
          pageHost.dataset.rendered = "rendering"
          void renderPage(pdf, pageHost)
        }
      },
      { root: null, rootMargin: "400px 0px", threshold: 0.01 },
    )
    host.querySelectorAll<HTMLElement>(".pdf-viewer__page").forEach((p) => observer.observe(p))

    // Add the expand/collapse toggle + zoom controls on the
    // figcaption (or just before, if no figcaption). Idempotent:
    // only one set of controls per figure, regardless of re-mounts.
    if (figure && !figure.querySelector(".pdf-embed__mode-toggle")) {
      // Page-width zoom: persisted per pdfSrc so reopening the same
      // paper preserves the user's zoom level.
      const widthKey = `pdfPageMaxWidth:${src}`
      const minW = 360
      const maxW = 1200
      const stepW = 80
      const defaultW = 720
      const initial = (() => {
        try {
          const stored = Number(window.localStorage?.getItem(widthKey))
          if (Number.isFinite(stored) && stored >= minW && stored <= maxW) return stored
        } catch {}
        return defaultW
      })()
      const applyWidth = (w: number) => {
        figure.style.setProperty("--pdf-page-max-width", `${w}px`)
        try { window.localStorage?.setItem(widthKey, String(w)) } catch {}
        // Re-render any already-rendered page so its canvas matches
        // the new CSS width (otherwise the rasterized text stays at
        // the old scale until the user scrolls past + back).
        host.querySelectorAll<HTMLElement>(".pdf-viewer__page[data-rendered='1']").forEach((p) => {
          p.dataset.rendered = ""
          p.replaceChildren()
        })
        host.querySelectorAll<HTMLElement>(".pdf-viewer__page").forEach((p) => observer.observe(p))
      }
      applyWidth(initial)
      let currentW = initial

      const widthDown = document.createElement("button")
      widthDown.type = "button"
      widthDown.className = "pdf-embed__zoom-btn"
      widthDown.title = "Narrower pages (smaller text)"
      widthDown.setAttribute("aria-label", "Narrower PDF pages")
      widthDown.textContent = "A−"
      widthDown.addEventListener("click", () => {
        currentW = Math.max(minW, currentW - stepW)
        applyWidth(currentW)
      })

      const widthUp = document.createElement("button")
      widthUp.type = "button"
      widthUp.className = "pdf-embed__zoom-btn"
      widthUp.title = "Wider pages (larger text)"
      widthUp.setAttribute("aria-label", "Wider PDF pages")
      widthUp.textContent = "A+"
      widthUp.addEventListener("click", () => {
        currentW = Math.min(maxW, currentW + stepW)
        applyWidth(currentW)
      })

      const toggle = document.createElement("button")
      toggle.type = "button"
      toggle.className = "pdf-embed__mode-toggle"
      toggle.setAttribute("aria-label", "Toggle PDF expand mode")
      const refresh = () => {
        const mode = figure.dataset.pdfMode === "collapsed" ? "collapsed" : "expanded"
        toggle.textContent = mode === "expanded" ? "Collapse pages" : "Expand all pages"
      }
      refresh()
      toggle.addEventListener("click", () => {
        figure.dataset.pdfMode = figure.dataset.pdfMode === "collapsed" ? "expanded" : "collapsed"
        refresh()
        // Re-attach the IntersectionObserver to newly visible pages
        // — collapsed→expanded reveals pages 2+ that were display:none.
        host.querySelectorAll<HTMLElement>(".pdf-viewer__page").forEach((p) => observer.observe(p))
      })

      const cap = figure.querySelector(".pdf-embed__caption")
      if (cap) {
        // Insert as a group so the buttons sit together at the start.
        cap.insertAdjacentElement("afterbegin", widthUp)
        cap.insertAdjacentElement("afterbegin", widthDown)
        cap.insertAdjacentElement("afterbegin", toggle)
      } else {
        figure.appendChild(toggle)
        figure.appendChild(widthDown)
        figure.appendChild(widthUp)
      }
    }

    mounted.set(host, { src, pdf, observer })

    // Tell the rest of the system that new .block-card nodes have
    // appeared so block-toolbar (click handlers) and the widget
    // runtime (cached annotations re-mount) can pick them up. Both
    // listen for `nav` already; this custom event is the runtime
    // analogue for cards that didn't exist at SPA-nav time.
    ;(document.dispatchEvent as (e: Event) => boolean)(new CustomEvent("quartz:blocks-added"))
  } catch (err) {
    host.replaceChildren()
    const errEl = document.createElement("div")
    errEl.className = "pdf-viewer__status pdf-viewer__status--error"
    const msg = err instanceof Error ? err.message : "unknown error"
    errEl.textContent = `Couldn't load PDF: ${msg}`
    host.appendChild(errEl)
  } finally {
    if (inFlight.get(host) === src) inFlight.delete(host)
  }
}

async function renderPage(pdf: PdfDoc, pageHost: HTMLElement): Promise<void> {
  const pageNum = Number(pageHost.dataset.pageNum)
  if (!Number.isFinite(pageNum)) return
  try {
    const page = await pdf.getPage(pageNum)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)  // cap to avoid huge canvases
    // Scale so the rendered canvas is ~ the host's current width (or
    // a reasonable default if the host hasn't been laid out yet).
    const cssWidth = pageHost.clientWidth || 800
    const baseViewport = page.getViewport({ scale: 1 })
    const cssScale = cssWidth / baseViewport.width
    const renderScale = cssScale * dpr
    const viewport = page.getViewport({ scale: renderScale })

    const canvas = document.createElement("canvas")
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    canvas.style.width = "100%"
    canvas.style.height = "auto"
    canvas.style.display = "block"

    const ctx = canvas.getContext("2d")
    if (!ctx) {
      pageHost.dataset.rendered = ""
      return
    }
    // pdfjs-dist's RenderParameters added a required `canvas` field
    // alongside `canvasContext` in newer versions; pass both for
    // forward compatibility.
    await page.render({ canvas, canvasContext: ctx, viewport } as Parameters<typeof page.render>[0]).promise
    pageHost.replaceChildren(canvas)
    pageHost.dataset.rendered = "1"
    pageHost.removeAttribute("style")  // drop the aspect-ratio placeholder; canvas drives the size now
  } catch (err) {
    pageHost.dataset.rendered = ""  // allow retry on next scroll
    console.warn("pdf page render failed", pageNum, err)
  }
}

function scan(): void {
  const figures = Array.from(document.querySelectorAll<HTMLElement>("figure.pdf-embed[data-pdf-src]"))
  for (const fig of figures) {
    const host = fig.querySelector<HTMLElement>(".pdf-viewer")
    if (!host) continue
    const src = fig.getAttribute("data-pdf-src") || ""
    if (!src) continue
    void mountViewer(host, src)
  }
}

// Spa nav: re-scan after every soft rebuild. The WeakMap key (host) is
// reused when micromorph keeps the DOM node, so mounted PDFs survive.
document.addEventListener("nav", scan)
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", scan, { once: true })
} else {
  scan()
}
