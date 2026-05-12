import { QuartzTransformerPlugin } from "../types"
import { visit } from "unist-util-visit"
import { toString } from "hast-util-to-string"
import { createHash } from "crypto"

// Stamp every <p> in the rendered HTML with data-paragraph-hash, derived
// from a normalized form of the paragraph text. Content-stable: editing
// unrelated paragraphs doesn't shift the hash. Used by the AI-comments
// widget to anchor live comments to the right paragraph after a build.
function normalize(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function hashParagraph(text: string): string {
  const normalized = normalize(text)
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12)
}

export const ParagraphHash: QuartzTransformerPlugin = () => {
  return {
    name: "ParagraphHash",
    htmlPlugins() {
      return [
        () => {
          return (tree: any) => {
            visit(tree, { type: "element", tagName: "p" }, (node: any) => {
              const text = toString(node)
              if (!text || !text.trim()) return
              node.properties = node.properties || {}
              node.properties["data-paragraph-hash"] = hashParagraph(text)
            })
          }
        },
      ]
    },
  }
}
