// Tiny helpers used by treeDepth.ts. Keeping them in their own module lets
// codegen produce import lines that don't pull in anything platform-y.

export function isNull(x: unknown): boolean {
  return x === null
}

export function max(a: number, b: number): number {
  return a > b ? a : b
}

export function addOne(n: number): number {
  return n + 1
}
