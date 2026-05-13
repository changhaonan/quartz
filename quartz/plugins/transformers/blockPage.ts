import { QuartzTransformerPlugin } from "../types"
import { Element, Root as HTMLRoot } from "hast"
import { toString } from "hast-util-to-string"
import { createHash } from "crypto"

// Block-page renderer: when a page sets `blocks: true` in frontmatter,
// each top-level body element (paragraph / heading / list / code block /
// blockquote / table / figure) is wrapped in a card with a hover toolbar
// (copy / comment / Jarvis-here / move).
//
// Wrapper structure:
//   <div class="block-card block-card--<kind>" data-block-id="<hash>">
//     <… original element …>
//     <div class="block-card__toolbar" aria-hidden="true">
//       <button data-block-action="copy">⧉</button>
//       <button data-block-action="comment">💬</button>
//       <button data-block-action="jarvis-here">★</button>
//       <button data-block-action="move" disabled>↕</button>
//     </div>
//   </div>
//
// For <p>, the block id reuses the existing data-paragraph-hash from
// the ParagraphHash transformer. For other tags, we hash the rendered
// text content the same way (sha1 of normalized text → first 12 hex).
//
// IMPORTANT: this plugin runs AFTER ParagraphHash so paragraph hashes
// are already present. Register order in quartz.config.ts.

const WRAPPABLE_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "blockquote", "pre", "table", "figure",
])

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase()
}

function hashText(text: string): string {
  return createHash("sha1").update(normalize(text)).digest("hex").slice(0, 12)
}

export const BlockPage: QuartzTransformerPlugin = () => {
  return {
    name: "BlockPage",
    htmlPlugins() {
      return [
        () => {
          return (tree: HTMLRoot, file) => {
            const enabled = file.data.frontmatter?.blocks === true
              || String(file.data.frontmatter?.blocks).toLowerCase() === "true"
            if (!enabled) return

            const wrapElement = (el: Element): Element => {
              let hash = String(el.properties?.["data-paragraph-hash"] || "")
              if (!hash) {
                const text = toString(el)
                if (!text || !text.trim()) return el  // skip empty
                hash = hashText(text)
                el.properties = el.properties || {}
                el.properties["data-block-id"] = hash  // also stamp inner so client can match either
              }
              return {
                type: "element",
                tagName: "div",
                properties: {
                  // `id` matters: micromorph's diff identity excludes
                  // data-* attributes, so without an `id` two block-cards
                  // with the same class look identical to it and a
                  // reorder degenerates into "edit innerHTML in place" —
                  // keeping the wrapper div fixed and just shuffling
                  // text. The id makes wrappers move correctly.
                  id: `block-${hash}`,
                  className: ["block-card", `block-card--${el.tagName}`],
                  "data-block-id": hash,
                  draggable: "true",
                },
                children: [
                  el,
                  {
                    type: "element",
                    tagName: "div",
                    properties: {
                      className: ["block-card__toolbar"],
                      "aria-hidden": "true",
                    },
                    children: [
                      makeToolbarBtn("copy", "Copy block text", "⧉"),
                      makeToolbarBtn("comment", "Add my own annotation", "💬"),
                      makeToolbarBtn("jarvis-here", "Ask Jarvis to comment on this block", "★"),
                      makeToolbarBtn("move", "Move (v2 — coming soon)", "↕", true),
                    ],
                  },
                ],
              }
            }

            const newChildren: HTMLRoot["children"] = []
            for (const child of tree.children) {
              if (child.type === "element" && WRAPPABLE_TAGS.has(child.tagName)) {
                const text = toString(child)
                if (text && text.trim()) {
                  newChildren.push(wrapElement(child))
                  continue
                }
              }
              newChildren.push(child)
            }
            tree.children = newChildren
          }
        },
      ]
    },
  }
}

function makeToolbarBtn(action: string, title: string, label: string, disabled = false): Element {
  const props: Record<string, unknown> = {
    type: "button",
    "data-block-action": action,
    className: ["block-card__btn"],
    title,
    "aria-label": title,
  }
  if (disabled) props.disabled = true
  return {
    type: "element",
    tagName: "button",
    properties: props,
    children: [{ type: "text", value: label }],
  }
}
