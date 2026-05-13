// Block-page hover toolbar wiring. The transformer (blockPage.ts) emits
// .block-card containers with inert toolbar markup; this script gives
// the buttons behavior:
//
//   📋 copy    — write the block's plain-text content to the clipboard
//   💬 comment — seed a Jarvis-runtime widget for this block with an
//                empty AI comment + composer initially open, so the
//                user can immediately start typing their own annotation.
//                Re-uses the existing block-widget runtime so the
//                annotation is persisted across reloads (localStorage).
//   ↕ move    — disabled in v1 (markdown source-reorder is a v2 task).
//
// Hooked into the spa nav lifecycle so it re-binds after every soft
// rebuild.

import { getBlockWidgetRuntime } from "./block-widget-runtime.inline"

type AnnotationState = {
  comment: string
  thread: Array<{ role: "ai" | "user"; text: string; createdAt?: string }>
  saved: boolean
  dismissedIndexes: number[]
  likedIndexes: number[]
  /** When true, the AI-comment widget mounts with the composer open
   * even if no AI comment exists. Used by "comment on this block" so
   * the user can type their annotation immediately. */
  composerInitiallyOpen?: boolean
  commentCreatedAt?: string
}

function bindBlockToolbars(): void {
  const cards = Array.from(document.querySelectorAll<HTMLElement>(".block-card[data-block-id]"))
  for (const card of cards) {
    if (card.dataset.blockToolbarBound === "1") continue
    card.dataset.blockToolbarBound = "1"

    card.addEventListener("click", async (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-block-action]")
      if (!target) return
      if (target.disabled) return
      const action = target.dataset.blockAction
      const blockId = card.dataset.blockId || ""
      if (!blockId) return

      if (action === "copy") {
        // Copy the block's body text regardless of element kind. Was
        // previously p-only, which silently failed (clipboard untouched)
        // on heading / list / blockquote / pre / table / figure blocks.
        const inner = card.querySelector<HTMLElement>(
          "p[data-paragraph-hash], p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, figure",
        )
        const text = (inner?.innerText || inner?.textContent || "").trim()
        if (!text) {
          flashFeedback(target, "Nothing to copy", true)
          return
        }
        try {
          await navigator.clipboard.writeText(text)
          flashFeedback(target, "Copied")
        } catch {
          flashFeedback(target, "Copy failed", true)
        }
        return
      }

      if (action === "comment") {
        // Seed an AI-comment widget with no AI comment but composer open.
        // The widget's mount renders just the composer (no AI peer) so
        // the user can immediately type an annotation.
        const runtime = getBlockWidgetRuntime()
        const existing = runtime.get<AnnotationState>("ai-comment", blockId)
        if (existing && !existing.saved) {
          // Already has a widget; just re-open composer by re-seeding
          // the open flag and remounting via attachAll.
          runtime.set<AnnotationState>("ai-comment", blockId, {
            ...existing,
            composerInitiallyOpen: true,
          })
        } else {
          runtime.set<AnnotationState>("ai-comment", blockId, {
            comment: "",
            thread: [],
            saved: false,
            dismissedIndexes: [],
            likedIndexes: [],
            composerInitiallyOpen: true,
            commentCreatedAt: undefined,
          })
        }
        runtime.attachAll()
        return
      }

      if (action === "jarvis-here") {
        // Ask Jarvis to comment on JUST this block. Reuses the same
        // /api/ai-comments/generate endpoint with a single-paragraph
        // payload, then merges the response into the existing widget
        // state (preserves any prior user annotations on this block).
        const sidebar = document.querySelector<HTMLElement>(".ai-sidebar")
        if (!sidebar) { flashFeedback(target, "no sidebar", true); return }
        const bridgeOrigin = sidebar.getAttribute("data-bridge-origin") || ""
        if (!bridgeOrigin) { flashFeedback(target, "no bridge", true); return }
        const slug = sidebar.dataset.fileSlug || ""
        // Detect PDF embed: when the block wraps a <figure data-pdf-src>,
        // pass the pdf path to the bridge so it can extract the paper's
        // actual text. Otherwise the bridge would only see the figcaption
        // ("Open foo.pdf ↗") and produce a comment about the link, not
        // the paper. Per-page synthetic cards (block-card--pdf-page)
        // carry data-pdf-src + data-pdf-page directly on the card; we
        // forward pageNumber so the bridge extracts that page only.
        const isPerPage = card.classList.contains("block-card--pdf-page")
        const pdfFigure = card.querySelector<HTMLElement>("figure.pdf-embed[data-pdf-src]")
        const pdfSrc = isPerPage
          ? (card.getAttribute("data-pdf-src") || "")
          : (pdfFigure?.getAttribute("data-pdf-src") || "")
        const pageNumber = isPerPage ? Number(card.getAttribute("data-pdf-page") || "0") : 0
        const innerEl = card.querySelector<HTMLElement>("p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, figure")
        const text = (innerEl?.textContent || "").replace(/\s+/g, " ").trim()
        if (!text && !pdfSrc) { flashFeedback(target, "empty block", true); return }
        target.disabled = true
        const originalLabel = target.textContent
        target.textContent = "…"
        try {
          const para: { hash: string; text: string; pdfSrc?: string; pageNumber?: number } = {
            hash: blockId,
            text: text || (pageNumber > 0 ? `[PDF page ${pageNumber}: ${pdfSrc}]` : `[PDF: ${pdfSrc}]`),
          }
          if (pdfSrc) para.pdfSrc = pdfSrc
          if (pageNumber > 0) para.pageNumber = pageNumber
          const res = await fetch(`${bridgeOrigin}/api/ai-comments/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Role-Id": "admin" },
            body: JSON.stringify({ slug, paragraphs: [para] }),
          })
          const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; comments?: Array<{ hash: string; comment: string }> }
          if (!res.ok || !payload.ok) throw new Error(payload.error || `bridge ${res.status}`)
          const c = (payload.comments || []).find((x) => x.hash === blockId)
          if (!c) {
            flashFeedback(target, "Nothing to add", false)
            return
          }
          const runtime = getBlockWidgetRuntime()
          const existing = runtime.get<AnnotationState>("ai-comment", blockId)
          runtime.set<AnnotationState>("ai-comment", blockId, {
            ...(existing || { thread: [], saved: false, dismissedIndexes: [], likedIndexes: [] }),
            comment: c.comment,
            commentCreatedAt: new Date().toISOString(),
          })
          runtime.attachAll()
          flashFeedback(target, "Done", false)
        } catch (error) {
          const message = error instanceof Error ? error.message : "jarvis failed"
          flashFeedback(target, message.slice(0, 12), true)
        } finally {
          target.disabled = false
          if (originalLabel) target.textContent = originalLabel
        }
        return
      }

      if (action === "move") {
        // Drag from anywhere on the card; the toolbar button is just a
        // hint that this block is movable. Show a tip and bail.
        flashFeedback(target, "Drag block ↕", false)
        return
      }
    })
  }
}

// ── Drag-and-drop reorder ────────────────────────────────────────
// Each .block-card is draggable (set in the transformer). On drop we
// compute the new order from DOM and POST to the bridge, which rewrites
// the source markdown. Quartz's --serve picks up the change and our
// soft-morph patch re-renders the article.

let dragSrcCard: HTMLElement | null = null
let dropIndicator: HTMLElement | null = null

function ensureDropIndicator(): HTMLElement {
  // Look for an existing one first — soft-morph may have preserved one
  // from a prior drag (we mark it data-persist so micromorph doesn't
  // delete it during article re-render).
  const existing = document.querySelector<HTMLElement>(".block-drop-indicator")
  if (existing) { dropIndicator = existing; return existing }
  const el = document.createElement("div")
  el.className = "block-drop-indicator"
  el.setAttribute("data-persist", "true")
  el.style.display = "none"
  document.body.appendChild(el)
  dropIndicator = el
  return el
}
function hideDropIndicator() {
  const el = dropIndicator || document.querySelector<HTMLElement>(".block-drop-indicator")
  if (el) el.style.display = "none"
}

// Document-level delegation: bind ONCE, ever. Per-card binding doesn't
// survive micromorph soft-morphs cleanly — micromorph removes our
// data-block-drag-bound attribute (it's not in the new HTML) and the
// next bindBlockDragHandlers call would stack a second set of identical
// handlers on the same DOM nodes, leading to double POSTs on drop.
// Delegation routes events from the document level so it doesn't matter
// how many times block-cards are patched.

function findBlockCard(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null
  return target.closest<HTMLElement>(".block-card[data-block-id][draggable='true']")
}

// Interactive descendants of a draggable block-card whose own
// mouse/click semantics must win over the card-level drag. Without
// this, clicking an <a> inside a card starts a link-drag in Chrome
// (text/uri-list goes into dataTransfer) and the user's click never
// becomes a navigation. Same shape for buttons / form controls so the
// toolbar icons keep working.
const INTERACTIVE_SELECTOR = "a, button, input, textarea, select, label, summary, [contenteditable='true']"
function targetIsInteractive(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest(INTERACTIVE_SELECTOR))
}

let blockDragDelegated = false
function bindBlockDragDelegation(): void {
  if (blockDragDelegated) return
  blockDragDelegated = true

  document.addEventListener("dragstart", (event) => {
    const card = findBlockCard(event.target)
    if (!card) return
    // Don't hijack drags that originated on an interactive element —
    // we want the native click (anchor nav, button activation) to win.
    if (targetIsInteractive(event.target)) {
      event.preventDefault()
      return
    }
    dragSrcCard = card
    card.classList.add("block-card--dragging")
    document.body.classList.add("block-dragging-active")
    try { event.dataTransfer?.setData("text/plain", card.dataset.blockId || "") } catch {}
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
  })

  document.addEventListener("dragend", (event) => {
    const card = findBlockCard(event.target) || dragSrcCard
    card?.classList.remove("block-card--dragging")
    document.body.classList.remove("block-dragging-active")
    hideDropIndicator()
    // Clear any lingering drop-position attributes.
    document.querySelectorAll<HTMLElement>(".block-card[data-drop-position]").forEach((c) => delete c.dataset.dropPosition)
    dragSrcCard = null
  })

  document.addEventListener("dragover", (event) => {
    const card = findBlockCard(event.target)
    if (!card || !dragSrcCard || dragSrcCard === card) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
    const rect = card.getBoundingClientRect()
    const insertBefore = event.clientY < rect.top + rect.height / 2
    const indicator = ensureDropIndicator()
    indicator.style.display = "block"
    indicator.style.left = `${rect.left}px`
    indicator.style.width = `${rect.width}px`
    indicator.style.top = `${(insertBefore ? rect.top : rect.bottom) - 1 + window.scrollY}px`
    card.dataset.dropPosition = insertBefore ? "before" : "after"
  })

  document.addEventListener("dragleave", (event) => {
    const card = findBlockCard(event.target)
    if (card) delete card.dataset.dropPosition
  })

  document.addEventListener("drop", async (event) => {
    const card = findBlockCard(event.target)
    if (!card) return
    event.preventDefault()
    hideDropIndicator()
    if (!dragSrcCard || dragSrcCard === card) {
      delete card.dataset.dropPosition
      return
    }
    const insertBefore = card.dataset.dropPosition === "before"
    delete card.dataset.dropPosition

    const article = card.closest("article")
    if (!article) return
    const allCards = Array.from(article.querySelectorAll<HTMLElement>(".block-card[data-block-id]"))
    const newOrder = allCards.filter((c) => c !== dragSrcCard)
    const targetIdx = newOrder.indexOf(card)
    if (targetIdx < 0) return
    newOrder.splice(insertBefore ? targetIdx : targetIdx + 1, 0, dragSrcCard)

    const sidebar = document.querySelector<HTMLElement>(".ai-sidebar")
    const bridgeOrigin = sidebar?.getAttribute("data-bridge-origin") || ""
    const slug = sidebar?.dataset.fileSlug || ""
    if (!bridgeOrigin || !slug) {
      console.warn("block reorder: no bridge / slug")
      return
    }

    // Snapshot the original order so we can revert if the bridge write
    // fails. Then optimistically reorder the DOM. With id="block-<hash>"
    // on each card, micromorph's later soft-morph correctly matches by
    // id and our pre-applied order matches the server's, so the morph
    // is a no-op visually — eliminating the 500-1000ms perceived gap.
    const originalOrder = allCards.slice()
    const parent = card.parentElement
    if (parent) {
      for (const c of newOrder) parent.appendChild(c)
    }
    const blockOrder = newOrder.map((c) => {
      const innerEl = c.querySelector<HTMLElement>("p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, figure")
      const text = (innerEl?.innerText || innerEl?.textContent || "").replace(/\s+/g, " ").trim()
      return { hash: c.dataset.blockId || "", prefix: text.slice(0, 60) }
    })
    try {
      // Tell the dev WS handler (quartz/plugins/index.ts) to skip the
      // soft-morph triggered by THIS reorder. Our optimistic DOM
      // rearrange above already put the block in the right place; the
      // morph would only redundantly diff the article, and as a side
      // effect wipe runtime-only DOM state like PDF.js canvases inside
      // .pdf-viewer (since the new HTML's empty placeholder doesn't
      // match the populated live DOM). 3 second window covers
      // bridge-write → quartz-rebuild → ws-push.
      ;(window as Window & { __quartzSuppressNextRebuild?: number }).__quartzSuppressNextRebuild =
        Date.now() + 3000
      const res = await fetch(`${bridgeOrigin}/api/blocks/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Role-Id": "admin" },
        body: JSON.stringify({ slug, blockOrder }),
      })
      const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (!res.ok || !payload.ok) throw new Error(payload.error || `bridge ${res.status}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : "reorder failed"
      console.error("block reorder failed:", message)
      // Revert the optimistic DOM rearrange.
      if (parent) for (const c of originalOrder) parent.appendChild(c)
    }
  })
}

// Bind delegation once on load. nav events still trigger bindBlockToolbars
// for the click-based actions (those are fine to re-bind: they check a
// flag) but drag handlers go through delegation.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bindBlockDragDelegation, { once: true })
} else {
  bindBlockDragDelegation()
}

function flashFeedback(btn: HTMLButtonElement, msg: string, isError = false): void {
  const original = btn.textContent
  btn.textContent = msg
  btn.classList.toggle("block-card__btn--error", isError)
  btn.classList.toggle("block-card__btn--ok", !isError)
  window.setTimeout(() => {
    btn.textContent = original
    btn.classList.remove("block-card__btn--ok", "block-card__btn--error")
  }, 900)
}

document.addEventListener("nav", bindBlockToolbars)
// pdf-viewer (and any future runtime) creates new .block-card nodes
// after spa nav has already fired; this hook lets them re-bind.
document.addEventListener("quartz:blocks-added", bindBlockToolbars)
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bindBlockToolbars, { once: true })
} else {
  window.setTimeout(bindBlockToolbars, 0)
}
