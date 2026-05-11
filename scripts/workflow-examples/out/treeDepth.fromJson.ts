import { addOne, isNull, max } from "./treeDepthHelpers"

export async function treeDepth(node) {
  if (isNull(node)) {
    return 0
  }
  const leftDepth = await treeDepth(node.left)
  const rightDepth = await treeDepth(node.right)
  const both = await max(leftDepth, rightDepth)
  const result = await addOne(both)
  return result
}
