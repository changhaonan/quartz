import { StaticResources } from "../util/resources"
import { FilePath, FullSlug } from "../util/path"
import { BuildCtx } from "../util/ctx"

export function getStaticResourcesFromPlugins(ctx: BuildCtx) {
  const staticResources: StaticResources = {
    css: [],
    js: [],
    additionalHead: [],
  }

  for (const transformer of [...ctx.cfg.plugins.transformers, ...ctx.cfg.plugins.emitters]) {
    const res = transformer.externalResources ? transformer.externalResources(ctx) : {}
    if (res?.js) {
      staticResources.js.push(...res.js)
    }
    if (res?.css) {
      staticResources.css.push(...res.css)
    }
    if (res?.additionalHead) {
      staticResources.additionalHead.push(...res.additionalHead)
    }
  }

  // if serving locally, listen for rebuilds and reload the page
  if (ctx.argv.serve) {
    const wsUrl = ctx.argv.remoteDevHost
      ? `wss://${ctx.argv.remoteDevHost}:${ctx.argv.wsPort}`
      : `ws://localhost:${ctx.argv.wsPort}`

    staticResources.js.push({
      loadTime: "afterDOMReady",
      contentType: "inline",
      script: `
        const socket = new WebSocket('${wsUrl}')
        // Quartz fork: replace document.location.reload(true) with a soft
        // SPA-style morph via window.spaNavigate (defined in spa.inline.ts).
        // Reason: a full reload causes the entire page to flash + lose any
        // client-side widget state (AI comments, scroll position, etc.) on
        // every markdown change. Soft morph keeps the page mostly intact
        // and lets our block-widget-runtime re-attach widgets via the
        // dispatched 'nav' event. Fall back to a hard reload if for some
        // reason spaNavigate isn't ready yet.
        socket.addEventListener('message', () => {
          if (typeof window.spaNavigate === 'function') {
            try {
              window.spaNavigate(new URL(window.location.href), true)
              return
            } catch (e) {
              console.warn('soft reload failed, falling back:', e)
            }
          }
          document.location.reload(true)
        })
      `,
    })
  }

  return staticResources
}

export * from "./transformers"
export * from "./filters"
export * from "./emitters"

declare module "vfile" {
  // inserted in processors.ts
  interface DataMap {
    slug: FullSlug
    filePath: FilePath
    relativePath: FilePath
  }
}
