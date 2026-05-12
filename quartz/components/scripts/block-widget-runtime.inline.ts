// Block-anchored client widget runtime.
//
// Background: Quartz's hot-rebuild replaces the entire <article> DOM when
// source markdown changes. Any client-side widget mounted onto that DOM
// loses its state on rebuild. This runtime separates the three concerns:
//
//   Identity  — every block carries a stable id (e.g., paragraph hash).
//   State     — widget state lives in a memory store keyed by (page,
//               blockId, widgetType). It outlives the DOM.
//   Mount     — widgets declare a `match` function over DOM nodes and a
//               `mount` function that paints UI from cached state. The
//               runtime re-runs `attachAll()` on every `nav` event.
//
// This is the same Identity/State/Mount split Warp uses for terminal
// blocks (BlockId on every subsystem; rendering re-derived from state),
// adapted to a DOM + hot-rebuild world.
//
// Today only the AI-comment widget uses this. Pattern is intentionally
// general so code-cell / illustration / discussion-thread widgets can
// plug in later without touching the runtime.

export interface WidgetCtx<TState> {
  blockId: string
  pageSlug: string
  /** Persist a new state for this widget instance and remount. */
  setState(next: TState): void
  /** Drop this widget instance from the store entirely. */
  destroy(): void
}

export interface BlockWidget<TState> {
  type: string
  /** Decide whether this widget binds to a given DOM node. Return the
   * stable blockId for the node, or null to skip. */
  match(node: HTMLElement): string | null
  /** Initial state for a fresh blockId (used when nothing is in store). */
  defaultState(): TState
  /** Paint the widget into the page. Returns an optional cleanup that
   * is called before remount or on destroy. */
  mount(
    node: HTMLElement,
    state: TState,
    ctx: WidgetCtx<TState>,
  ): void | (() => void)
  /** Selector hint so the runtime can scope its DOM walk. Optional;
   * default walks all elements. */
  rootSelector?: string
}

type WidgetState = unknown
type InstanceKey = string  // `${type}::${blockId}`
type PageStore = Map<InstanceKey, WidgetState>

// localStorage key for the entire serialized widget store. We persist
// the whole thing on every mutation; cheap because state is small and
// mutations are user-driven (not high-frequency). v3 design (2026-05-12):
// "not deleted == kept" — widget state IS the canonical record, no
// separate markdown write step. Hence localStorage (cross-tab, survives
// browser restart) instead of sessionStorage (per-tab only).
const STORE_KEY = "quartz-pty:block-widget-runtime:v2"
// Scroll-preservation key remains in sessionStorage — scroll restore is
// only meaningful within a single tab's reload cycle.
const SCROLL_SESSION_KEY = "quartz-pty:block-widget-runtime:scroll"
const SCROLL_RESTORE_TTL_MS = 10_000

class BlockWidgetRuntime {
  private widgets = new Map<string, BlockWidget<WidgetState>>()
  private store = new Map<string, PageStore>()
  private cleanups = new Map<InstanceKey, () => void>()  // per-instance, per attachAll cycle

  constructor() {
    this.hydrateFromStorage()
  }

  private hydrateFromStorage(): void {
    try {
      const raw = window.localStorage.getItem(STORE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, Record<InstanceKey, WidgetState>>
      if (!parsed || typeof parsed !== "object") return
      for (const [pageSlug, instances] of Object.entries(parsed)) {
        if (!instances || typeof instances !== "object") continue
        const pageMap: PageStore = new Map()
        for (const [k, v] of Object.entries(instances)) pageMap.set(k, v)
        this.store.set(pageSlug, pageMap)
      }
    } catch {
      // localStorage unavailable / malformed JSON — just start empty.
    }
  }

  private persistToStorage(): void {
    try {
      const obj: Record<string, Record<InstanceKey, WidgetState>> = {}
      for (const [pageSlug, pageMap] of this.store.entries()) {
        const inst: Record<InstanceKey, WidgetState> = {}
        for (const [k, v] of pageMap.entries()) inst[k] = v
        obj[pageSlug] = inst
      }
      window.localStorage.setItem(STORE_KEY, JSON.stringify(obj))
    } catch {
      // local storage full / disabled — best effort, in-memory still works
    }
  }

  register<TState>(widget: BlockWidget<TState>): void {
    this.widgets.set(widget.type, widget as unknown as BlockWidget<WidgetState>)
  }

  private pageKey(): string {
    try {
      return window.location.pathname || "/"
    } catch {
      return "/"
    }
  }

  private pageStore(): PageStore {
    const key = this.pageKey()
    let s = this.store.get(key)
    if (!s) {
      s = new Map()
      this.store.set(key, s)
    }
    return s
  }

  private instanceKey(type: string, blockId: string): InstanceKey {
    return `${type}::${blockId}`
  }

  /** Seed (or replace) state for a specific widget instance. */
  set<TState>(type: string, blockId: string, state: TState): void {
    this.pageStore().set(this.instanceKey(type, blockId), state)
    this.persistToStorage()
  }

  /** Read current state (or undefined if none). */
  get<TState>(type: string, blockId: string): TState | undefined {
    return this.pageStore().get(this.instanceKey(type, blockId)) as TState | undefined
  }

  /** Drop a single widget instance. */
  delete(type: string, blockId: string): void {
    const key = this.instanceKey(type, blockId)
    this.pageStore().delete(key)
    const cleanup = this.cleanups.get(key)
    if (cleanup) {
      try { cleanup() } catch {}
      this.cleanups.delete(key)
    }
    this.persistToStorage()
  }

  /** Walk every registered widget against the current DOM, (re-)mounting
   * each instance from cached state. Idempotent — safe to call after
   * every hot-rebuild. */
  attachAll(): void {
    this.maybeRestoreScroll()
    // Run cleanups from prior cycle first.
    for (const fn of this.cleanups.values()) {
      try { fn() } catch {}
    }
    this.cleanups.clear()

    const pageSlug = this.pageKey()
    const pageStore = this.pageStore()
    for (const widget of this.widgets.values()) {
      const root = widget.rootSelector
        ? document.querySelectorAll<HTMLElement>(widget.rootSelector)
        : document.querySelectorAll<HTMLElement>("article *, article")
      for (const node of Array.from(root)) {
        const blockId = widget.match(node)
        if (!blockId) continue
        const key = this.instanceKey(widget.type, blockId)
        let state = pageStore.get(key) as WidgetState
        if (state === undefined) continue  // no seeded state -> nothing to mount
        const ctx: WidgetCtx<WidgetState> = {
          blockId,
          pageSlug,
          setState: (next) => {
            pageStore.set(key, next)
            this.persistToStorage()  // must go through persistence — see Phase A bug log
            // Re-mount this single instance: cleanup current, then mount fresh.
            const prevCleanup = this.cleanups.get(key)
            if (prevCleanup) { try { prevCleanup() } catch {} }
            this.cleanups.delete(key)
            const refreshed = widget.match(node)
            if (refreshed !== blockId) return  // node has shifted; let next attachAll handle it
            const newCleanup = widget.mount(node, next, ctx)
            if (typeof newCleanup === "function") this.cleanups.set(key, newCleanup)
          },
          destroy: () => this.delete(widget.type, blockId),
        }
        const cleanup = widget.mount(node, state, ctx)
        if (typeof cleanup === "function") this.cleanups.set(key, cleanup)
      }
    }
  }

  /** Drop every instance of `type` on the current page. Used when a
   * widget kind is being re-seeded en masse (e.g., user clicks AI Read
   * again and we want stale comments gone). */
  clearByType(type: string): void {
    const prefix = `${type}::`
    const pageStore = this.pageStore()
    for (const key of Array.from(pageStore.keys())) {
      if (!key.startsWith(prefix)) continue
      pageStore.delete(key)
      const cleanup = this.cleanups.get(key)
      if (cleanup) {
        try { cleanup() } catch {}
        this.cleanups.delete(key)
      }
    }
    this.persistToStorage()
  }

  /** Capture current scroll position to be restored after the next
   * full-page reload (used when a widget is about to mutate content
   * that quartz dev-server will rebuild). */
  markPendingRebuild(): void {
    try {
      window.sessionStorage.setItem(
        SCROLL_SESSION_KEY,
        JSON.stringify({
          pathname: window.location.pathname,
          scrollY: window.scrollY,
          ts: Date.now(),
        }),
      )
    } catch {}
  }

  private maybeRestoreScroll(): void {
    try {
      const raw = window.sessionStorage.getItem(SCROLL_SESSION_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as { pathname?: string; scrollY?: number; ts?: number }
      window.sessionStorage.removeItem(SCROLL_SESSION_KEY)
      if (!parsed || typeof parsed.scrollY !== "number") return
      if (parsed.pathname !== window.location.pathname) return
      if (typeof parsed.ts !== "number" || Date.now() - parsed.ts > SCROLL_RESTORE_TTL_MS) return
      // Defer to next frame so the browser's default scroll-to-top
      // (which fires during the load cycle) is overridden.
      requestAnimationFrame(() => window.scrollTo({ top: parsed.scrollY!, behavior: "auto" }))
    } catch {}
  }

  /** Clear all state for the current page (useful when user explicitly
   * resets, not typically called automatically). */
  clearPage(): void {
    for (const fn of this.cleanups.values()) {
      try { fn() } catch {}
    }
    this.cleanups.clear()
    this.store.delete(this.pageKey())
    this.persistToStorage()
  }
}

let singleton: BlockWidgetRuntime | null = null
export function getBlockWidgetRuntime(): BlockWidgetRuntime {
  if (!singleton) singleton = new BlockWidgetRuntime()
  return singleton
}
