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
  // Prefer the source node's declared output name verbatim — that's what the
  // parser stores when reading TS (e.g. outputs=["leftDepth"]) and it lets
  // round-tripped code reference the original variable names.
  if (source.outputs.length === 1 && source.outputs[0]) {
    return safeIdentifier(source.outputs[0], "out")
  }
  return safeIdentifier(`${source.id}_out`, source.id)
}

function nodeOutputVarName(node: WorkflowNode): string {
  // Variable name produced by `const X = call(...)`. Mirrors edgeVarName so
  // that downstream nodes referencing this output via varName resolve to the
  // same identifier.
  if (node.outputs.length === 1 && node.outputs[0]) {
    return safeIdentifier(node.outputs[0], "out")
  }
  return safeIdentifier(`${node.id}_out`, node.id)
}

function paramLiteral(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

function readArgsFromParams(node: WorkflowNode): string[] | null {
  // The parser stores positional argument expressions under `_args.N` keys
  // (so property accesses, literals, and computed exprs survive a TS round
  // trip without needing synthetic literal nodes). When present, the codegen
  // emits these verbatim and ignores both incoming-edge varNames and the
  // entry-param fallback for this node.
  const params = (node.params ?? {}) as Record<string, unknown>
  const indexed: { i: number; v: string }[] = []
  for (const [k, v] of Object.entries(params)) {
    const m = k.match(/^_args\.(\d+)$/)
    if (m && typeof v === "string") {
      indexed.push({ i: Number(m[1]), v })
    }
  }
  if (indexed.length === 0) return null
  indexed.sort((a, b) => a.i - b.i)
  return indexed.map((p) => p.v)
}

function nonInternalParamEntries(node: WorkflowNode): [string, unknown][] {
  return Object.entries(node.params ?? {}).filter(
    ([k]) => !k.startsWith("_args.") && k !== "_await",
  )
}

function renderCallArgs(
  node: WorkflowNode,
  ctx: CodegenContext,
  entryParams: string[],
  rootEntryConsumed: { value: boolean },
): string {
  const explicit = readArgsFromParams(node)
  if (explicit !== null) {
    // Mark entry params consumed if this orphan node took them on a previous
    // codegen — we don't actually need to mark, but doing so keeps the
    // first-orphan invariant.
    if ((ctx.incomingByNode.get(node.id) ?? []).length === 0) {
      rootEntryConsumed.value = true
    }
    return explicit.join(", ")
  }

  const incoming = ctx.incomingByNode.get(node.id) ?? []
  const positional: string[] = []
  if (incoming.length === 0 && entryParams.length > 0 && !rootEntryConsumed.value) {
    // Convention: the first orphan call/llm node gets the workflow's entry
    // parameters as positional args, in declaration order. Subsequent
    // orphans render as `op()` and the user can wire incoming edges or set
    // params kwargs to give them inputs.
    rootEntryConsumed.value = true
    for (const p of entryParams) positional.push(safeIdentifier(p, "_"))
  } else {
    for (const e of incoming) {
      const sourceNode = ctx.nodeById.get(e.source)
      if (!sourceNode) continue
      positional.push(edgeVarName(e, sourceNode))
    }
  }
  const kwargs = nonInternalParamEntries(node)
    .map(([k, v]) => `${safeIdentifier(k, "_")}: ${paramLiteral(v)}`)
  if (kwargs.length > 0) {
    positional.push(`{ ${kwargs.join(", ")} }`)
  }
  return positional.join(", ")
}

function renderCallStatement(
  node: WorkflowNode,
  ctx: CodegenContext,
  indent: string,
  entryParams: string[],
  rootEntryConsumed: { value: boolean },
): string {
  const op = nodeOpName(node)
  const args = renderCallArgs(node, ctx, entryParams, rootEntryConsumed)
  const awaitPrefix =
    node.kind === "llm" ||
    node.kind === "ask" ||
    node.kind === "spawn" ||
    node.params._await === true
      ? "await "
      : ""
  // For multi-output destructure: const { a, b } = op(...). Single → const out = op(...).
  if (node.outputs.length > 1) {
    const fields = node.outputs.map((o) => safeIdentifier(o, "_")).join(", ")
    return `${indent}const { ${fields} } = ${awaitPrefix}${op}(${args})`
  }
  const outVar = nodeOutputVarName(node)
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

interface RenderArgs {
  entryParams: string[]
  rootEntryConsumed: { value: boolean }
}

function renderNode(
  node: WorkflowNode,
  ctx: CodegenContext,
  indent: string,
  args: RenderArgs,
): string {
  switch (node.kind) {
    case "note":
    case "callout":
    case "label":
      // Render as a comment.
      const text = (node.text || node.op || node.id).replace(/\r?\n/g, " ")
      return `${indent}// ${text}`
    case "return": {
      // Precedence (matches branch-predicate precedence):
      //   1. node.op when set — explicit return expression. Useful when
      //      the user wants `return back3.reply` while wired to back3.
      //   2. value-edge varName — typical case.
      //   3. "undefined" — last-resort literal so the function still
      //      type-checks / runs.
      // Branch-arm edges are control-flow only, never value edges.
      if (node.op) return `${indent}return ${node.op}`
      const incoming = (ctx.incomingByNode.get(node.id) ?? []).filter((e) => {
        const src = ctx.nodeById.get(e.source)
        return src?.kind !== "branch"
      })
      if (incoming.length > 0) {
        const sourceNode = ctx.nodeById.get(incoming[0].source)
        if (sourceNode) {
          return `${indent}return ${edgeVarName(incoming[0], sourceNode)}`
        }
      }
      return `${indent}return undefined`
    }
    case "branch": {
      // Predicate priority:
      //   1. node.op when set — the user wrote an explicit predicate
      //      (e.g. "node === null" or "val < node.val").
      //   2. incoming edge varName when op is empty — the predicate is
      //      whatever the incoming flow brought in.
      //   3. fall back to "true" so generated code at least parses.
      const incoming = ctx.incomingByNode.get(node.id) ?? []
      const cond = node.op
        ? node.op
        : incoming.length > 0
          ? edgeVarName(incoming[0], ctx.nodeById.get(incoming[0].source)!)
          : "true"
      const out = ctx.outgoingByNode.get(node.id) ?? []
      const yesEdge = out.find((e) => e.sourceHandle === "source-top")
      const noEdge = out.find((e) => e.sourceHandle === "source-bottom")
      const yesBranch = yesEdge ? renderBranchBody(yesEdge.target, ctx, indent + "  ", args) : `${indent}  // (no yes branch)`
      // Omit the else block entirely when there's no source-bottom edge — the
      // original code may not have had an else, in which case the post-branch
      // flow continues sequentially after the if-block.
      if (noEdge) {
        const noBranch = renderBranchBody(noEdge.target, ctx, indent + "  ", args)
        return `${indent}if (${cond}) {\n${yesBranch}\n${indent}} else {\n${noBranch}\n${indent}}`
      }
      return `${indent}if (${cond}) {\n${yesBranch}\n${indent}}`
    }
    case "loop": {
      const body = ctx.childrenByContainer.get(node.id) ?? []
      const loopVar = safeIdentifier(`${node.id}_i`, "i")
      const bodyOrdered = topologicalOrder(body, ctx)
      const bodyLines = bodyOrdered.map((n) => renderNode(n, ctx, indent + "  ", args)).join("\n")
      return `${indent}for (let ${loopVar} = 0; ${loopVar} < ${node.loopCount}; ${loopVar}++) {\n${bodyLines}\n${indent}}`
    }
    case "parallel": {
      const body = ctx.childrenByContainer.get(node.id) ?? []
      const branches = body
        .map((n) => `${indent}  (async () => { ${renderNode(n, ctx, "", args).trim()} })()`)
        .join(",\n")
      return `${indent}await Promise.all([\n${branches}\n${indent}])`
    }
    case "call":
    case "llm":
    case "ask":
    case "spawn":
    default:
      return renderCallStatement(node, ctx, indent, args.entryParams, args.rootEntryConsumed)
  }
}

function renderBranchBody(
  targetId: string,
  ctx: CodegenContext,
  indent: string,
  args: RenderArgs,
): string {
  const node = ctx.nodeById.get(targetId)
  if (!node) return `${indent}// (missing target ${targetId})`
  // Walk forward through the branch: render this node, then any node whose
  // only incoming edge comes from it (and isn't merged with the post-branch
  // flow). This lets a single branch arm contain a chain ending in a return.
  const lines: string[] = [renderNode(node, ctx, indent, args)]
  let current: WorkflowNode | undefined = node
  const seen = new Set([node.id])
  while (current) {
    const out = ctx.outgoingByNode.get(current.id) ?? []
    if (out.length !== 1) break
    const nextNode = ctx.nodeById.get(out[0].target)
    if (!nextNode || seen.has(nextNode.id)) break
    const nextIncoming = ctx.incomingByNode.get(nextNode.id) ?? []
    // Only follow the chain if this node is the sole reachable predecessor —
    // otherwise the target belongs to the shared post-branch flow.
    if (nextIncoming.length !== 1) break
    seen.add(nextNode.id)
    lines.push(renderNode(nextNode, ctx, indent, args))
    current = nextNode
  }
  return lines.join("\n")
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

  // Also: nodes consumed by a branch arm's chain (via renderBranchBody) get
  // skipped from the top-level walk to avoid double-rendering. We compute
  // them up front by simulating the chain.
  const consumedByBranchChain = new Set<string>()
  for (const id of consumedByBranch) {
    const seen = new Set([id])
    let current: WorkflowNode | undefined = ctx.nodeById.get(id)
    while (current) {
      const out = ctx.outgoingByNode.get(current.id) ?? []
      if (out.length !== 1) break
      const nextNode = ctx.nodeById.get(out[0].target)
      if (!nextNode || seen.has(nextNode.id)) break
      const nextIncoming = ctx.incomingByNode.get(nextNode.id) ?? []
      if (nextIncoming.length !== 1) break
      consumedByBranchChain.add(nextNode.id)
      seen.add(nextNode.id)
      current = nextNode
    }
  }

  const renderArgs: RenderArgs = {
    entryParams: data.entryParams,
    rootEntryConsumed: { value: false },
  }
  const bodyLines = ordered
    .filter((n) => !consumedByBranch.has(n.id) && !consumedByBranchChain.has(n.id))
    .map((n) => renderNode(n, ctx, "  ", renderArgs))
    .join("\n")

  const entryName = safeIdentifier(options.entryName ?? "workflow", "workflow")
  const params = data.entryParams.map((p) => safeIdentifier(p, "_")).join(", ")
  const importsBlock = data.imports.length > 0
    ? data.imports.map((line) => line.trim()).filter(Boolean).join("\n") + "\n\n"
    : ""

  // Choose a return value: only emit a trailing `return X` when the body
  // doesn't already end in an explicit `return` (e.g. through a `return`
  // node or every branch arm returning).
  const trailingReturnNeeded = !bodyLines.split("\n").some((line) => /^\s*return\b/.test(line))
  const lastNode = ordered
    .filter(
      (n) =>
        (n.kind === "call" || n.kind === "llm" || n.kind === "ask" || n.kind === "spawn") &&
        !consumedByBranchChain.has(n.id),
    )
    .pop()
  const returnLine = trailingReturnNeeded && lastNode
    ? `  return ${safeIdentifier(`${lastNode.id}_${lastNode.outputs[0] ?? "out"}`, lastNode.id)}\n`
    : ""

  if (consumedByBranch.size > 0 && bodyLines.match(/^\s*$/)) {
    warnings.push("graph reduces to nothing after branch consumption — check decision wiring")
  }

  // Cap the body with a newline before the closing brace so the formatter
  // and human readers see `}` on its own line.
  const bodyClosing = bodyLines || returnLine ? "\n" : ""
  const source = `${importsBlock}export async function ${entryName}(${params}) {\n${bodyLines}${bodyLines && returnLine ? "\n" : ""}${returnLine}${bodyClosing}}\n`

  return { source, warnings }
}
