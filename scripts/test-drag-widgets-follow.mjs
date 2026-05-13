// Verify the user-reported "comment block pops to the top" bug:
// dragging a non-adjacent block past another block left
// .ai-comment-widget asides at the article TOP (because the
// reorder loop only reparented .block-card[data-block-id] nodes
// and didn't carry along their trailing widget siblings).
//
// We exercise the algorithm directly: stage a synthetic article
// DOM, attach widgets after each card, run the same group-and-
// reparent logic the drop handler now uses, and assert the
// widgets stay next to their cards.
import assert from "node:assert/strict"

// Synthetic DOM (no jsdom dep — manual mock that's just enough
// for the parent.appendChild reorder to work).
class Node {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase()
    this.attrs = attrs
    this.classList = {
      _set: new Set((attrs.class || "").split(/\s+/).filter(Boolean)),
      contains(c) { return this._set.has(c) },
      add(c) { this._set.add(c) },
    }
    this.children = []
    this.parentElement = null
  }
  appendChild(c) {
    if (c.parentElement) {
      const i = c.parentElement.children.indexOf(c)
      if (i >= 0) c.parentElement.children.splice(i, 1)
    }
    c.parentElement = this
    this.children.push(c)
    return c
  }
  get nextElementSibling() {
    if (!this.parentElement) return null
    const i = this.parentElement.children.indexOf(this)
    return this.parentElement.children[i + 1] || null
  }
}

const article = new Node("article")
const cardA = new Node("div", { class: "block-card", "data-block-id": "A" })
const widgetA = new Node("aside", { class: "ai-comment-widget" })
const cardB = new Node("div", { class: "block-card", "data-block-id": "B" })
const widgetB = new Node("aside", { class: "ai-comment-widget" })
const cardC = new Node("div", { class: "block-card", "data-block-id": "C" })
const widgetC = new Node("aside", { class: "ai-comment-widget" })
const cardD = new Node("div", { class: "block-card", "data-block-id": "D" })
for (const n of [cardA, widgetA, cardB, widgetB, cardC, widgetC, cardD]) article.appendChild(n)

const idsBefore = article.children.map((n) => n.attrs["data-block-id"] || `[${n.attrs.class}]`)
console.log("before:", idsBefore.join(" "))

// Simulate dragging cardA (the heading) to AFTER cardC. New order
// (cards only): B, C, A, D. Reorder logic from the drop handler.
const newOrder = [cardB, cardC, cardA, cardD]

const groups = newOrder.map((c) => {
  const widgets = []
  let next = c.nextElementSibling
  while (next && next.classList.contains("ai-comment-widget")) {
    widgets.push(next)
    next = next.nextElementSibling
  }
  return { card: c, widgets }
})
for (const { card, widgets } of groups) {
  article.appendChild(card)
  for (const w of widgets) article.appendChild(w)
}

const idsAfter = article.children.map((n) => n.attrs["data-block-id"] || `[${n.attrs.class}]`)
console.log("after: ", idsAfter.join(" "))

// Assertions:
// 1. Each widget should immediately follow its associated card.
const expected = ["B", "[ai-comment-widget]", "C", "[ai-comment-widget]", "A", "[ai-comment-widget]", "D"]
assert.deepEqual(idsAfter, expected, "widgets should follow their cards, not pop to top")
console.log("✓ widgets follow their cards (no pop-to-top)")

// 2. The OLD broken behavior — widgets at the top — would have produced:
//    [ai-comment-widget, ai-comment-widget, ai-comment-widget, B, C, A, D]
// Verify we are NOT in that state.
const widgetsAtTop = idsAfter.slice(0, 3).every((s) => s.includes("ai-comment-widget"))
assert.equal(widgetsAtTop, false, "widgets must NOT be at the top")
console.log("✓ widgets are NOT pushed to the top")

console.log("\nALL CHECKS PASSED")
