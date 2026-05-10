import { addOne, isNull, max } from "./treeDepthHelpers"

export async function treeDepth(node) {
  if (isNull(node)) {
    return 0
  }
  const leftDepth = await treeDepth(node.left)
  const rightDepth = await treeDepth(node.right)
  const both = max(leftDepth, rightDepth)
  const result = addOne(both)
  return result}
