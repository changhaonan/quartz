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
  if (existing && existing.src === src) return  // already mounted
  if (inFlight.get(host) === src) return  // already mounting same src

  // Teardown any previous viewer on this host (different src).
  if (existing) {
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
    const aspectRatio = firstViewport.height / firstViewport.width

    for (let p = 1; p <= pdf.numPages; p++) {
      const pageHost = document.createElement("div")
      pageHost.className = "pdf-viewer__page"
      pageHost.setAttribute("data-page-num", String(p))
      pageHost.style.aspectRatio = `${firstViewport.width} / ${firstViewport.height}`
      void aspectRatio  // referenced; kept for clarity
      host.appendChild(pageHost)
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
    mounted.set(host, { src, pdf, observer })
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
    await page.render({ canvasContext: ctx, viewport }).promise
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
