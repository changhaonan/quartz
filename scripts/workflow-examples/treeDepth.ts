// Canonical hand-authored treeDepth: recursive max-depth of a binary tree.
// Pure-functional (no mutation), uses one branch (null check) and two
// recursive calls + helpers. The round-trip verifier (scripts/workflow-
// roundtrip.mjs) parses this into a workflow JSON and codegens it back.

import { addOne, isNull, max } from "./treeDepthHelpers"

export async function treeDepth(node) {
  if (isNull(node)) {
    return 0
  }
  const leftDepth = await treeDepth(node.left)
  const rightDepth = await treeDepth(node.right)
  const both = max(leftDepth, rightDepth)
  const result = addOne(both)
  return result
}
