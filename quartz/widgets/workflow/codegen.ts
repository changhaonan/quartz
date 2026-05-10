// Codegen: workflow board → TypeScript source.
//
// The generated code is a subset of TS — sequential `const X = op(args)`
// statements, `if/else` for branch nodes, `for` loops for loop nodes,
// `await Promise.all([...])` for parallel containers, and a thin entry
// function wrapping the whole thing. The output is meant to be readable
// by both a human and an LLM agent; it is NOT meant to round-trip
// formatting (parser, when added, will normalize).

import type { WorkflowBoardData, WorkflowNode, WorkflowEdge } from "./schema"

interface CodegenContext {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  nodeById: Map<string, WorkflowNode>
  outgoingByNode: Map<string, WorkflowEdge[]>
  incomingByNode: Map<string, WorkflowEdge[]>
  childrenByContainer: Map<string, WorkflowNode[]>
}

function buildContext(data: WorkflowBoardData): CodegenContext {
  const nodeById = new Map<string, WorkflowNode>()
  const outgoingByNode = new Map<string, WorkflowEdge[]>()
  const incomingByNode = new Map<string, WorkflowEdge[]>()
  const childrenByContainer = new Map<string, WorkflowNode[]>()

  for (const n of data.nodes) {
    nodeById.set(n.id, n)
    outgoingByNode.set(n.id, [])
    incomingByNode.set(n.id, [])
    if (n.containerId) {
      const arr = childrenByContainer.get(n.containerId) ?? []
      arr.push(n)
      childrenByContainer.set(n.containerId, arr)
    }
  }
  for (const e of data.edges) {
    outgoingByNode.get(e.source)?.push(e)
    incomingByNode.get(e.target)?.push(e)
  }
  return { nodes: data.nodes, edges: data.edges, nodeById, outgoingByNode, incomingByNode, childrenByContainer }
}

function safeIdentifier(raw: string, fallback: string): string {
  const trimmed = String(raw || "").trim()
  if (!trimmed) return fallback
  // Replace invalid chars with underscore, ensure starts with letter.
  const cleaned = trimmed.replace(/[^A-Za-z0-9_$]/g, "_")
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`
}

function nodeOpName(node: WorkflowNode): string {
  if (node.op) return safeIdentifier(node.op, node.id)
  // Fall back to the node id, with kind prefix to keep readable.
  return safeIdentifier(`${node.kind}_${node.id}`, node.id)
}

function edgeVarName(edge: WorkflowEdge, source: WorkflowNode): string {
  if (edge.varName) return safeIdentifier(edge.varName, "out")
  // Auto-derive: `<sourceId>_out` (or sourceId if outputs has one entry named).
  if (source.outputs.length === 1) {
    return safeIdentifier(`${source.id}_${source.outputs[0]}`, source.id)
  }
  return safeIdentifier(`${source.id}_out`, source.id)
}

function paramLiteral(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

function renderCallArgs(node: WorkflowNode, ctx: CodegenContext): string {
  // Collected from incoming edges (variable bindings) + node.params (literal kwargs).
  const incoming = ctx.incomingByNode.get(node.id) ?? []
  const positional: string[] = []
  for (const e of incoming) {
    const sourceNode = ctx.nodeById.get(e.source)
    if (!sourceNode) continue
    positional.push(edgeVarName(e, sourceNode))
  }
  const kwargs = Object.entries(node.params || {})
    .map(([k, v]) => `${safeIdentifier(k, "_")}: ${paramLiteral(v)}`)
  if (kwargs.length > 0) {
    positional.push(`{ ${kwargs.join(", ")} }`)
  }
  return positional.join(", ")
}

function renderCallStatement(node: WorkflowNode, ctx: CodegenContext, indent: string): string {
  const op = nodeOpName(node)
  const args = renderCallArgs(node, ctx)
  // For multi-output destructure: const { a, b } = op(...). Single → const out = op(...).
  if (node.outputs.length > 1) {
    const fields = node.outputs.map((o) => safeIdentifier(o, "_")).join(", ")
    return `${indent}const { ${fields} } = ${op === "llm" ? "await " : ""}${op}(${args})`
  }
  const outVar = safeIdentifier(`${node.id}_${node.outputs[0] ?? "out"}`, node.id)
  const awaitPrefix = node.kind === "llm" ? "await " : ""
  return `${indent}const ${outVar} = ${awaitPrefix}${op}(${args})`
}

function topologicalOrder(nodes: WorkflowNode[], ctx: CodegenContext): WorkflowNode[] {
  // Kahn's algorithm restricted to the given subset.
  const ids = new Set(nodes.map((n) => n.id))
  const indeg = new Map<string, number>()
  for (const n of nodes) {
    let count = 0
    for (const e of ctx.incomingByNode.get(n.id) ?? []) {
      if (ids.has(e.source)) count++
    }
    indeg.set(n.id, count)
  }
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0)
  const ordered: WorkflowNode[] = []
  while (queue.length > 0) {
    const next = queue.shift()!
    ordered.push(next)
    for (const e of ctx.outgoingByNode.get(next.id) ?? []) {
      if (!ids.has(e.target)) continue
      const newDeg = (indeg.get(e.target) ?? 1) - 1
      indeg.set(e.target, newDeg)
      if (newDeg === 0) {
        const tnode = nodes.find((n) => n.id === e.target)
        if (tnode) queue.push(tnode)
      }
    }
  }
  // Append any nodes left in cycles (shouldn't happen for non-loop graphs).
  for (const n of nodes) if (!ordered.includes(n)) ordered.push(n)
  return ordered
}

function renderNode(node: WorkflowNode, ctx: CodegenContext, indent: string): string {
  switch (node.kind) {
    case "note":
    case "callout":
    case "label":
      // Render as a comment.
      const text = (node.text || node.op || node.id).replace(/\r?\n/g, " ")
      return `${indent}// ${text}`
    case "branch": {
      const incoming = ctx.incomingByNode.get(node.id) ?? []
      const cond = incoming.length > 0
        ? edgeVarName(incoming[0], ctx.nodeById.get(incoming[0].source)!)
        : (node.op || "true")
      const out = ctx.outgoingByNode.get(node.id) ?? []
      const yesEdge = out.find((e) => e.sourceHandle === "source-top")
      const noEdge = out.find((e) => e.sourceHandle === "source-bottom")
      const yesBranch = yesEdge ? renderBranchBody(yesEdge.target, ctx, indent + "  ") : `${indent}  // (no yes branch)`
      const noBranch = noEdge ? renderBranchBody(noEdge.target, ctx, indent + "  ") : `${indent}  // (no no branch)`
      return `${indent}if (${cond}) {\n${yesBranch}\n${indent}} else {\n${noBranch}\n${indent}}`
    }
    case "loop": {
      const body = ctx.childrenByContainer.get(node.id) ?? []
      const loopVar = safeIdentifier(`${node.id}_i`, "i")
      const bodyOrdered = topologicalOrder(body, ctx)
      const bodyLines = bodyOrdered.map((n) => renderNode(n, ctx, indent + "  ")).join("\n")
      return `${indent}for (let ${loopVar} = 0; ${loopVar} < ${node.loopCount}; ${loopVar}++) {\n${bodyLines}\n${indent}}`
    }
    case "parallel": {
      const body = ctx.childrenByContainer.get(node.id) ?? []
      const branches = body
        .map((n) => `${indent}  (async () => { ${renderNode(n, ctx, "").trim()} })()`)
        .join(",\n")
      return `${indent}await Promise.all([\n${branches}\n${indent}])`
    }
    case "call":
    case "llm":
    default:
      return renderCallStatement(node, ctx, indent)
  }
}

function renderBranchBody(targetId: string, ctx: CodegenContext, indent: string): string {
  // For a branch arm we emit just the target node's statement. Deeper graphs
  // are handled by the surrounding sequential walk; an arm pointing into the
  // shared post-branch flow is fine because that flow will be emitted in the
  // top-level walk later.
  const node = ctx.nodeById.get(targetId)
  if (!node) return `${indent}// (missing target ${targetId})`
  return renderNode(node, ctx, indent)
}

export interface CodegenResult {
  source: string
  warnings: string[]
}

export function generateWorkflowSource(data: WorkflowBoardData, options: { entryName?: string } = {}): CodegenResult {
  const ctx = buildContext(data)
  const warnings: string[] = []

  // Top-level nodes (no containerId): the body of the entry function. Loop /
  // parallel children are rendered inside their container, so we exclude them
  // from the top-level walk.
  const topLevel = data.nodes.filter((n) => !n.containerId)
  // Nodes already rendered as part of a branch arm: skip in the top-level
  // walk. (For now we don't dedupe — branch bodies often share the post-flow
  // and that's fine; the codegen reader can eyeball duplicates.)
  const ordered = topologicalOrder(topLevel, ctx)
  // Branch nodes consume the targets of their two arms; any node whose only
  // incoming edge comes from a branch handle should be rendered inside the
  // branch and skipped here.
  const consumedByBranch = new Set<string>()
  for (const n of topLevel) {
    if (n.kind !== "branch") continue
    for (const e of ctx.outgoingByNode.get(n.id) ?? []) {
      if (e.sourceHandle === "source-top" || e.sourceHandle === "source-bottom") {
        consumedByBranch.add(e.target)
      }
    }
  }

  const bodyLines = ordered
    .filter((n) => !consumedByBranch.has(n.id))
    .map((n) => renderNode(n, ctx, "  "))
    .join("\n")

  const entryName = safeIdentifier(options.entryName ?? "workflow", "workflow")
  const params = data.entryParams.map((p) => safeIdentifier(p, "_")).join(", ")
  const importsBlock = data.imports.length > 0
    ? data.imports.map((line) => line.trim()).filter(Boolean).join("\n") + "\n\n"
    : ""

  // Choose a return value: the last sequential output, if any.
  const lastNode = ordered.filter((n) => n.kind === "call" || n.kind === "llm").pop()
  const returnLine = lastNode
    ? `  return ${safeIdentifier(`${lastNode.id}_${lastNode.outputs[0] ?? "out"}`, lastNode.id)}\n`
    : ""

  if (consumedByBranch.size > 0 && bodyLines.match(/^\s*$/)) {
    warnings.push("graph reduces to nothing after branch consumption — check decision wiring")
  }

  const source = `${importsBlock}export async function ${entryName}(${params}) {\n${bodyLines}${bodyLines && returnLine ? "\n" : ""}${returnLine}}\n`

  return { source, warnings }
}
