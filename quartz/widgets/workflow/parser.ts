// TypeScript subset → workflow JSON parser.
//
// Walks the AST of a hand-authored .workflow.ts file and produces a
// WorkflowBoardData structure. The dual of codegen.ts: codegen turns a graph
// into TS, parser turns TS into a graph. Together they round-trip through a
// narrow subset:
//
//   const x = call(args)          → call/llm node + edges from arg vars
//   const x = await call(args)    → llm node (or call with _await=true)
//   const { a, b } = call(args)   → call node with multi outputs
//   if (cond) { ... } else { ... } → branch node + two arm chains
//   return expr                    → return node (op = expr verbatim)
//   for (let i = 0; i < N; i++) { → loop node, body nested via containerId
//   await Promise.all([...])      → parallel node, body nested
//
// Anything outside this subset (try/catch, while, switch, ternary at top
// level, etc.) gets emitted as a comment node so authoring stays bidirectional
// for the supported subset and degrades visibly for the rest.

import ts from "typescript"
import type {
  WorkflowBoardData,
  WorkflowEdge,
  WorkflowNode,
} from "./schema"

interface ParserContext {
  source: ts.SourceFile
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  // Variable name → id of the node whose output is bound to that name.
  bindings: Map<string, { nodeId: string; outputName: string }>
  nextNodeIndex: number
  nextEdgeIndex: number
}

function nextNodeId(ctx: ParserContext, hint: string): string {
  ctx.nextNodeIndex += 1
  return `${hint}-${ctx.nextNodeIndex}`
}

function nextEdgeId(ctx: ParserContext): string {
  ctx.nextEdgeIndex += 1
  return `e-${ctx.nextEdgeIndex}`
}

function getText(node: ts.Node, sf: ts.SourceFile): string {
  return node.getText(sf).trim()
}

function isAwaitedCall(expr: ts.Expression): expr is ts.AwaitExpression {
  return ts.isAwaitExpression(expr)
}

function unwrapAwait(expr: ts.Expression): {
  awaited: boolean
  inner: ts.Expression
} {
  if (isAwaitedCall(expr)) {
    return { awaited: true, inner: expr.expression }
  }
  return { awaited: false, inner: expr }
}

interface CallShape {
  isCall: true
  callee: string
  args: ts.Expression[]
  awaited: boolean
}

function asCallShape(expr: ts.Expression): CallShape | null {
  const { awaited, inner } = unwrapAwait(expr)
  if (!ts.isCallExpression(inner)) return null
  const callee = inner.expression.getText()
  return {
    isCall: true,
    callee,
    args: inner.arguments.slice(),
    awaited,
  }
}

function makeBaseNode(
  partial: Partial<WorkflowNode> & { id: string; kind: WorkflowNode["kind"] },
  index: number,
): WorkflowNode {
  return {
    id: partial.id,
    kind: partial.kind,
    visual: partial.visual,
    op: partial.op ?? "",
    params: (partial.params ?? {}) as WorkflowNode["params"],
    outputs: (partial.outputs ?? ["out"]) as WorkflowNode["outputs"],
    containerId: partial.containerId ?? "",
    x: partial.x ?? (index % 6) * 320 + 80,
    y: partial.y ?? Math.floor(index / 6) * 200 + 80,
    width: partial.width,
    height: partial.height,
    text: partial.text ?? "",
    color: (partial.color ?? "slate") as WorkflowNode["color"],
    ioPairs: partial.ioPairs ?? 1,
    loopCount: partial.loopCount ?? 1,
  }
}

function emitArgEdges(
  ctx: ParserContext,
  targetNodeId: string,
  args: ts.Expression[],
): { argTexts: string[]; varEdges: number } {
  const argTexts: string[] = []
  let varEdges = 0
  for (const arg of args) {
    const text = arg.getText(ctx.source).trim()
    argTexts.push(text)
    // If the arg is a plain identifier referencing a known binding, draw an
    // edge so the visual graph reflects the dataflow. Property accesses,
    // literals, and computed exprs stay only in params._args.
    if (ts.isIdentifier(arg)) {
      const binding = ctx.bindings.get(arg.text)
      if (binding) {
        ctx.edges.push({
          id: nextEdgeId(ctx),
          type: "arrow",
          source: binding.nodeId,
          target: targetNodeId,
          sourceHandle: "",
          targetHandle: "",
          varName: arg.text,
          label: "",
          color: "slate",
          route: null,
        })
        varEdges += 1
      }
    }
  }
  return { argTexts, varEdges }
}

function paramsFromArgs(argTexts: string[]): Record<string, string> {
  // Stash the arg expression strings in params under a `_args.N` keys. The
  // codegen reads `_args` (sorted by index) and emits them verbatim — that
  // way property access (`node.left`) and literals (`0`, `null`) survive
  // round-trip without needing a synthetic literal node.
  const out: Record<string, string> = {}
  argTexts.forEach((t, i) => {
    out[`_args.${i}`] = t
  })
  return out
}

/**
 * Pull recognized fields out of an object-literal expression and convert
 * them into JSON-shaped values for storage in a node's params. Used by
 * input-node parsing — `userInput({ inputType: "text", label: "..." })`
 * needs its single object-literal arg lifted into individual params keys
 * so codegen can re-emit it without a separate _args-style passthrough.
 */
function liftObjectLiteralParams(
  obj: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
  allowedKeys: readonly string[],
): Record<string, string | number | boolean | null | string[]> {
  const out: Record<string, string | number | boolean | null | string[]> = {}
  const allowed = new Set(allowedKeys)
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    let key: string
    if (ts.isIdentifier(prop.name)) key = prop.name.text
    else if (ts.isStringLiteral(prop.name)) key = prop.name.text
    else continue
    if (!allowed.has(key)) continue
    const v = prop.initializer
    if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) {
      out[key] = v.text
    } else if (ts.isNumericLiteral(v)) {
      out[key] = Number(v.text)
    } else if (v.kind === ts.SyntaxKind.TrueKeyword) {
      out[key] = true
    } else if (v.kind === ts.SyntaxKind.FalseKeyword) {
      out[key] = false
    } else if (v.kind === ts.SyntaxKind.NullKeyword) {
      out[key] = null
    } else if (ts.isArrayLiteralExpression(v)) {
      // Only string-array options round-trip cleanly through the schema.
      // Non-string elements get stringified to keep the shape consistent.
      const items: string[] = []
      for (const el of v.elements) {
        if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) {
          items.push(el.text)
        } else {
          items.push(el.getText(source))
        }
      }
      out[key] = items
    } else {
      // Fall back to the verbatim text — useful for `default: someVar`
      // expressions we don't try to resolve.
      out[key] = v.getText(source)
    }
  }
  return out
}

function declaredOutputNames(decl: ts.VariableDeclaration): string[] {
  if (ts.isIdentifier(decl.name)) return [decl.name.text]
  if (ts.isObjectBindingPattern(decl.name)) {
    const names: string[] = []
    for (const el of decl.name.elements) {
      if (ts.isIdentifier(el.name)) names.push(el.name.text)
    }
    return names
  }
  return ["out"]
}

function walkBlock(
  ctx: ParserContext,
  body: ts.Block,
  containerId: string = "",
): { lastNodeId: string | null } {
  let prevSequentialNodeId: string | null = null
  for (const stmt of body.statements) {
    const result = walkStatement(ctx, stmt, containerId, prevSequentialNodeId)
    if (result.nodeId) prevSequentialNodeId = result.nodeId
  }
  return { lastNodeId: prevSequentialNodeId }
}

function walkStatement(
  ctx: ParserContext,
  stmt: ts.Statement,
  containerId: string,
  prevSequentialNodeId: string | null,
): { nodeId: string | null } {
  if (ts.isVariableStatement(stmt)) {
    return walkVariableStatement(ctx, stmt, containerId)
  }
  if (ts.isReturnStatement(stmt)) {
    return walkReturnStatement(ctx, stmt, containerId)
  }
  if (ts.isIfStatement(stmt)) {
    return walkIfStatement(ctx, stmt, containerId)
  }
  if (ts.isForStatement(stmt)) {
    return walkForStatement(ctx, stmt, containerId)
  }
  if (ts.isExpressionStatement(stmt)) {
    return walkExpressionStatement(ctx, stmt, containerId)
  }
  // Unrecognized: emit as a note.
  const id = nextNodeId(ctx, "note")
  ctx.nodes.push(
    makeBaseNode(
      {
        id,
        kind: "note",
        visual: "note",
        text: getText(stmt, ctx.source).slice(0, 120),
        color: "amber",
        containerId,
      },
      ctx.nodes.length,
    ),
  )
  void prevSequentialNodeId
  return { nodeId: id }
}

function walkVariableStatement(
  ctx: ParserContext,
  stmt: ts.VariableStatement,
  containerId: string,
): { nodeId: string | null } {
  const decl = stmt.declarationList.declarations[0]
  if (!decl || !decl.initializer) return { nodeId: null }
  const init = decl.initializer
  const call = asCallShape(init)
  if (call) {
    const outputs = declaredOutputNames(decl)
    const id = nextNodeId(ctx, call.callee.replace(/[^A-Za-z0-9_$]/g, "_"))

    // Special case: userInput({ ... }) → kind:"input" with the spec lifted
    // into params. We intercept here (rather than letting the generic call
    // pathway run) because codegen renders input nodes from individual spec
    // keys, not from _args.N text — without lifting, round-trip would emit
    // `userInput({}, ...)` losing the spec.
    const calleeBareEarly = call.callee.split(".").pop() ?? call.callee
    if (calleeBareEarly === "userInput") {
      const params: Record<string, string | number | boolean | null | string[]> = {}
      const arg0 = call.args[0]
      if (arg0 && ts.isObjectLiteralExpression(arg0)) {
        Object.assign(
          params,
          liftObjectLiteralParams(arg0, ctx.source, [
            "inputType",
            "label",
            "default",
            "options",
            "help",
            "timeoutMs",
          ]),
        )
      }
      ctx.nodes.push(
        makeBaseNode(
          {
            id,
            kind: "input",
            visual: "input",
            op: "userInput",
            outputs,
            color: "amber",
            containerId,
            params: params as WorkflowNode["params"],
          },
          ctx.nodes.length,
        ),
      )
      for (const name of outputs) {
        ctx.bindings.set(name, { nodeId: id, outputName: name })
      }
      return { nodeId: id }
    }

    // Map well-known callee names to their dedicated kinds. These all imply
    // `await` already so we don't also set _await.
    const kindByCallee: Record<string, "ask" | "spawn" | "llm" | "call"> = {
      ask: "ask",
      spawn: "spawn",
      llm: "llm",
    }
    const calleeBare = call.callee.split(".").pop() ?? call.callee
    const inferredKind = kindByCallee[calleeBare]
    const finalKind = inferredKind ?? (call.awaited ? "llm" : "call")
    const finalColor = finalKind === "ask" ? "cyan" :
      finalKind === "spawn" ? "violet" :
      finalKind === "llm" ? "violet" :
      "cyan"
    const finalVisual = finalKind === "spawn" ? "artifact" : "process"
    ctx.nodes.push(
      makeBaseNode(
        {
          id,
          kind: finalKind,
          visual: finalVisual,
          op: call.callee,
          outputs,
          color: finalColor,
          containerId,
        },
        ctx.nodes.length,
      ),
    )
    const { argTexts } = emitArgEdges(ctx, id, call.args)
    const node = ctx.nodes[ctx.nodes.length - 1]
    Object.assign(node.params, paramsFromArgs(argTexts))
    // Codegen defaults to `await ` for every callable; `_await: false`
    // turns it off. For round-trip fidelity we record the parser's
    // observation explicitly: if the source had `await`, leave _await
    // unset (codegen will await anyway); if it didn't, pin _await: false
    // so codegen reproduces the missing `await` instead of inserting one.
    if (finalKind === "call" && !call.awaited) {
      ;(node.params as Record<string, unknown>)._await = false
    }
    for (const name of outputs) {
      ctx.bindings.set(name, { nodeId: id, outputName: name })
    }
    return { nodeId: id }
  }
  // Non-call initializer: treat as a comment.
  const id = nextNodeId(ctx, "expr")
  ctx.nodes.push(
    makeBaseNode(
      {
        id,
        kind: "note",
        visual: "note",
        text: getText(stmt, ctx.source).slice(0, 120),
        color: "amber",
        containerId,
      },
      ctx.nodes.length,
    ),
  )
  return { nodeId: id }
}

function walkReturnStatement(
  ctx: ParserContext,
  stmt: ts.ReturnStatement,
  containerId: string,
): { nodeId: string | null } {
  const id = nextNodeId(ctx, "return")
  const expr = stmt.expression
  let op = ""
  if (expr) {
    op = getText(expr, ctx.source)
  }
  ctx.nodes.push(
    makeBaseNode(
      {
        id,
        kind: "return",
        visual: "label",
        op,
        outputs: [],
        color: "mint",
        containerId,
      },
      ctx.nodes.length,
    ),
  )
  // If expr is a plain identifier, draw an edge from the binding.
  if (expr && ts.isIdentifier(expr)) {
    const binding = ctx.bindings.get(expr.text)
    if (binding) {
      ctx.edges.push({
        id: nextEdgeId(ctx),
        type: "arrow",
        source: binding.nodeId,
        target: id,
        sourceHandle: "",
        targetHandle: "",
        varName: expr.text,
        label: "",
        color: "slate",
        route: null,
      })
      // Once we have an incoming edge, codegen will use it instead of op.
      ctx.nodes[ctx.nodes.length - 1].op = ""
    }
  }
  return { nodeId: id }
}

function walkIfStatement(
  ctx: ParserContext,
  stmt: ts.IfStatement,
  containerId: string,
): { nodeId: string | null } {
  const condText = getText(stmt.expression, ctx.source)
  const id = nextNodeId(ctx, "branch")
  ctx.nodes.push(
    makeBaseNode(
      {
        id,
        kind: "branch",
        visual: "decision",
        op: condText,
        outputs: [],
        color: "rose",
        containerId,
      },
      ctx.nodes.length,
    ),
  )

  // Yes branch: source-top
  const thenStmt = stmt.thenStatement
  const yesFirstId = walkArm(ctx, thenStmt, containerId)
  if (yesFirstId) {
    ctx.edges.push({
      id: nextEdgeId(ctx),
      type: "arrow",
      source: id,
      target: yesFirstId,
      sourceHandle: "source-top",
      targetHandle: "",
      varName: "",
      label: "",
      color: "mint",
      route: null,
    })
  }

  // No branch: source-bottom
  if (stmt.elseStatement) {
    const noFirstId = walkArm(ctx, stmt.elseStatement, containerId)
    if (noFirstId) {
      ctx.edges.push({
        id: nextEdgeId(ctx),
        type: "arrow",
        source: id,
        target: noFirstId,
        sourceHandle: "source-bottom",
        targetHandle: "",
        varName: "",
        label: "",
        color: "rose",
        route: null,
      })
    }
  }

  return { nodeId: id }
}

function walkArm(
  ctx: ParserContext,
  stmt: ts.Statement,
  containerId: string,
): string | null {
  // Arms can be a Block or a single Statement. We want to record the FIRST
  // node of the arm chain so the branch edge can target it; subsequent
  // statements are emitted as siblings of containerId and discovered by the
  // codegen via topological order + the branch's chain heuristic.
  const armStartIndex = ctx.nodes.length
  if (ts.isBlock(stmt)) {
    walkBlock(ctx, stmt, containerId)
  } else {
    walkStatement(ctx, stmt, containerId, null)
  }
  return ctx.nodes[armStartIndex]?.id ?? null
}

function walkForStatement(
  ctx: ParserContext,
  stmt: ts.ForStatement,
  containerId: string,
): { nodeId: string | null } {
  // Heuristic: parse `for (let i = 0; i < N; i++)` to extract loopCount = N.
  let loopCount = 1
  if (
    stmt.condition &&
    ts.isBinaryExpression(stmt.condition) &&
    ts.isNumericLiteral(stmt.condition.right)
  ) {
    loopCount = Math.max(1, Number(stmt.condition.right.text))
  }
  const id = nextNodeId(ctx, "loop")
  ctx.nodes.push(
    makeBaseNode(
      {
        id,
        kind: "loop",
        visual: "stack",
        op: getText(stmt.condition ?? stmt, ctx.source).slice(0, 60),
        outputs: [],
        color: "violet",
        containerId,
        loopCount,
      },
      ctx.nodes.length,
    ),
  )
  if (ts.isBlock(stmt.statement)) {
    walkBlock(ctx, stmt.statement, id)
  } else {
    walkStatement(ctx, stmt.statement, id, null)
  }
  return { nodeId: id }
}

function walkExpressionStatement(
  ctx: ParserContext,
  stmt: ts.ExpressionStatement,
  containerId: string,
): { nodeId: string | null } {
  const expr = stmt.expression
  // `await Promise.all([ ... ])`
  const { awaited, inner } = unwrapAwait(expr)
  if (
    awaited &&
    ts.isCallExpression(inner) &&
    inner.expression.getText().endsWith("Promise.all") &&
    inner.arguments.length === 1 &&
    ts.isArrayLiteralExpression(inner.arguments[0])
  ) {
    const id = nextNodeId(ctx, "parallel")
    ctx.nodes.push(
      makeBaseNode(
        {
          id,
          kind: "parallel",
          visual: "lane",
          op: "Promise.all",
          outputs: [],
          color: "mint",
          containerId,
        },
        ctx.nodes.length,
      ),
    )
    // Each array element is a branch. We don't try to recover IIFE bodies
    // for v1 — we just record the expression text per branch as a child note.
    for (const branchExpr of (inner.arguments[0] as ts.ArrayLiteralExpression).elements) {
      const cid = nextNodeId(ctx, "branch-leg")
      ctx.nodes.push(
        makeBaseNode(
          {
            id: cid,
            kind: "note",
            visual: "note",
            text: branchExpr.getText(ctx.source).slice(0, 120),
            color: "amber",
            containerId: id,
          },
          ctx.nodes.length,
        ),
      )
    }
    return { nodeId: id }
  }
  // Bare call expression: emit as call node, but no output binding.
  const call = asCallShape(expr)
  if (call) {
    const id = nextNodeId(ctx, call.callee.replace(/[^A-Za-z0-9_$]/g, "_"))
    ctx.nodes.push(
      makeBaseNode(
        {
          id,
          kind: call.awaited ? "llm" : "call",
          visual: "process",
          op: call.callee,
          outputs: [],
          color: "cyan",
          containerId,
        },
        ctx.nodes.length,
      ),
    )
    const { argTexts } = emitArgEdges(ctx, id, call.args)
    Object.assign(ctx.nodes[ctx.nodes.length - 1].params, paramsFromArgs(argTexts))
    return { nodeId: id }
  }
  // Anything else: a comment node.
  const id = nextNodeId(ctx, "expr")
  ctx.nodes.push(
    makeBaseNode(
      {
        id,
        kind: "note",
        visual: "note",
        text: getText(stmt, ctx.source).slice(0, 120),
        color: "amber",
        containerId,
      },
      ctx.nodes.length,
    ),
  )
  return { nodeId: id }
}

export interface ParseResult {
  data: WorkflowBoardData
  entryName: string
  warnings: string[]
}

export function parseWorkflowSource(source: string): ParseResult {
  const sf = ts.createSourceFile(
    "workflow.ts",
    source,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
  )
  const ctx: ParserContext = {
    source: sf,
    nodes: [],
    edges: [],
    bindings: new Map(),
    nextNodeIndex: 0,
    nextEdgeIndex: 0,
  }
  const warnings: string[] = []
  const imports: string[] = []
  let entryName = "workflow"
  let entryParams: string[] = []
  let entryFound = false

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      imports.push(stmt.getText(sf).trim())
      continue
    }
    if (ts.isFunctionDeclaration(stmt)) {
      if (entryFound) {
        warnings.push(`extra function declaration ${stmt.name?.text ?? "?"} ignored`)
        continue
      }
      entryFound = true
      entryName = stmt.name?.text ?? "workflow"
      entryParams = stmt.parameters.map((p) =>
        ts.isIdentifier(p.name) ? p.name.text : "_",
      )
      // Pre-register entry params as bindings — but their nodeId is empty so
      // edges won't be drawn. Codegen's "first orphan call gets entryParams"
      // convention handles wiring on the regen side.
      // (We keep them visible to the binding-lookup so re-binds shadow them.)
      if (stmt.body) walkBlock(ctx, stmt.body, "")
      continue
    }
    warnings.push(`unsupported top-level statement: ${stmt.getText(sf).slice(0, 80)}`)
  }

  return {
    data: {
      schemaVersion: 1,
      imports,
      entryParams,
      nodes: ctx.nodes,
      edges: ctx.edges,
    },
    entryName,
    warnings,
  }
}
