import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"
import { FileTrieNode } from "./quartz/util/fileTrie"

// Explorer with the dashboard (主面板) pinned to the very top, then Quartz's
// default folders-first / alphabetical ordering. The sortFn is serialized to
// the client, so it must stay self-contained (no outer references).
const explorerOptions = {
  sortFn: (a: FileTrieNode, b: FileTrieNode) => {
    if (a.slug === "dashboard") return -1
    if (b.slug === "dashboard") return 1
    if ((!a.isFolder && !b.isFolder) || (a.isFolder && b.isFolder)) {
      return a.displayName.localeCompare(b.displayName, undefined, {
        numeric: true,
        sensitivity: "base",
      })
    }
    return !a.isFolder && b.isFolder ? 1 : -1
  },
}

// components shared across all pages
export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  afterBody: [
    // ToC + Backlinks used to live in the right sidebar; the rail's been
    // dropped to give the centre column more room. ToC stays accessible as
    // a floating, click-to-expand panel (position:fixed, top-right of the
    // viewport — see custom.scss). Backlinks renders inline at the bottom
    // of the article, which is also where they're conventionally placed
    // (e.g. Roam, Obsidian backlinks pane). The dashboard skips both — no
    // useful ToC headings, no meaningful backlinks.
    Component.ConditionalRender({
      component: Component.DesktopOnly(Component.TableOfContents()),
      condition: (page) => page.fileData.slug !== "dashboard/index",
    }),
    Component.ConditionalRender({
      component: Component.Backlinks(),
      condition: (page) => page.fileData.slug !== "dashboard/index",
    }),
    Component.WidgetHost(),
    Component.EnvBadge(),
  ],
  assistant: [Component.AiSidebar()],
  footer: Component.Footer({
    links: {
      GitHub: "https://github.com/jackyzha0/quartz",
      "Discord Community": "https://discord.gg/cRFFHYye7t",
    },
  }),
}

// components for pages that display a single page (e.g. a single note)
export const defaultContentPageLayout: PageLayout = {
  beforeBody: [
    Component.ConditionalRender({
      component: Component.Breadcrumbs(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ArticleTitle(),
    Component.ContentMeta(),
    Component.TagList(),
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
        { Component: Component.Language() },
        { Component: Component.ReaderMode() },
      ],
    }),
    Component.Explorer(explorerOptions),
  ],
  // Right rail dropped 2026-05-19 — Graph never showed anything useful, and
  // ToC + Backlinks have moved to `afterBody` (floating / inline). Every
  // page gets the centre column's full width.
  right: [],
}

// components for pages that display lists of pages  (e.g. tags or folders)
export const defaultListPageLayout: PageLayout = {
  beforeBody: [Component.Breadcrumbs(), Component.ArticleTitle(), Component.ContentMeta()],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
        { Component: Component.Language() },
      ],
    }),
    Component.Explorer(explorerOptions),
  ],
  right: [],
}
