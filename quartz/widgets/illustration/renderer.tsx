import { render } from "preact"
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks"
import type { WidgetMountContext } from "../types"
import {
  branchLabel,
  IllustrationBoardData,
  IllustrationEdge,
  IllustrationNode,
  isNoBranch,
  isYesBranch,
  NODE_COLOR_ACCENTS,
  NODE_TYPE_DEFAULTS,
  nodeSize,
} from "./schema"

interface BoardProps {
  initial: IllustrationBoardData
  ctx: WidgetMountContext<IllustrationBoardData>
}

interface DragState {
  id: string
  startClientX: number
  startClientY: number
  startNodeX: number
  startNodeY: number
}

const BRANCH_YES_COLOR = "#3da787"
const BRANCH_NO_COLOR = "#d96a8c"

function attachmentPoint(
  node: IllustrationNode,
  handle: string,
  isSource: boolean,
): { x: number; y: number; vertical: boolean } {
  const { width, height } = nodeSize(node)
  const cx = node.x + width / 2
  const cy = node.y + height / 2
  if (node.type === "decision") {
    if (handle === "source-top") return { x: cx, y: node.y, vertical: true }
    if (handle === "source-bottom") return { x: cx, y: node.y + height, vertical: true }
    if (isSource) return { x: node.x + width, y: cy, vertical: false }
    return { x: node.x, y: cy, vertical: false }
  }
  if (isSource) return { x: node.x + width, y: cy, vertical: false }
  return { x: node.x, y: cy, vertical: false }
}

function bezierPath(
  start: { x: number; y: number; vertical: boolean },
  end: { x: number; y: number; vertical: boolean },
  waypoint: { x: number; y: number } | null,
): string {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const distance = Math.sqrt(dx * dx + dy * dy)
  const c = Math.max(40, distance * 0.4)
  const cs = start.vertical
    ? { x: start.x, y: start.y + (dy >= 0 ? c : -c) }
    : { x: start.x + (dx >= 0 ? c : -c), y: start.y }
  const ct = end.vertical
    ? { x: end.x, y: end.y + (dy >= 0 ? -c : c) }
    : { x: end.x + (dx >= 0 ? -c : c), y: end.y }
  if (waypoint) {
    return `M ${start.x} ${start.y} Q ${waypoint.x} ${waypoint.y} ${end.x} ${end.y}`
  }
  return `M ${start.x} ${start.y} C ${cs.x} ${cs.y}, ${ct.x} ${ct.y}, ${end.x} ${end.y}`
}

function edgeStrokeColor(edge: IllustrationEdge): string {
  if (isYesBranch(edge)) return BRANCH_YES_COLOR
  if (isNoBranch(edge)) return BRANCH_NO_COLOR
  return NODE_COLOR_ACCENTS[edge.color]
}

function NodeShape({ node }: { node: IllustrationNode }) {
  const { width, height } = nodeSize(node)
  const accent = NODE_COLOR_ACCENTS[node.color]
  const fill = "var(--light)"
  switch (node.type) {
    case "decision":
      return (
        <polygon
          points={`${width / 2},0 ${width},${height / 2} ${width / 2},${height} 0,${height / 2}`}
          fill={fill}
          stroke={accent}
          stroke-width={1.8}
        />
      )
    case "artifact": {
      const fold = 14
      const d = `M 0 0 L ${width - fold} 0 L ${width} ${fold} L ${width} ${height} L 0 ${height} Z`
      return (
        <g>
          <path d={d} fill={fill} stroke={accent} stroke-width={1.6} />
          <path
            d={`M ${width - fold} 0 L ${width - fold} ${fold} L ${width} ${fold}`}
            fill="none"
            stroke={accent}
            stroke-width={1.2}
            stroke-linejoin="round"
          />
        </g>
      )
    }
    case "callout":
      return (
        <rect
          width={width}
          height={height}
          rx={10}
          ry={10}
          fill={fill}
          stroke={accent}
          stroke-width={1.4}
          stroke-dasharray="6 4"
        />
      )
    case "label":
      return (
        <rect
          width={width}
          height={height}
          rx={height / 2}
          ry={height / 2}
          fill={fill}
          stroke={accent}
          stroke-width={1.4}
        />
      )
    case "lane":
    case "group":
      return (
        <g>
          <rect
            width={width}
            height={height}
            rx={10}
            ry={10}
            fill={fill}
            stroke={accent}
            stroke-width={1.6}
          />
          <rect
            width={width}
            height={28}
            rx={10}
            ry={10}
            fill={accent}
            opacity="0.18"
          />
          <line
            x1={0}
            y1={28}
            x2={width}
            y2={28}
            stroke={accent}
            stroke-width={1}
            opacity="0.5"
          />
        </g>
      )
    case "stack": {
      const ports = Math.max(1, Math.min(6, node.ioPairs ?? 1))
      const portRadius = 4
      const portXs = [4, width - 4]
      const stripes = []
      for (let i = 0; i < ports; i++) {
        const yy = ((i + 0.5) / ports) * (height - 28) + 28
        for (const px of portXs) {
          stripes.push(
            <circle
              key={`port-${px}-${i}`}
              cx={px}
              cy={yy}
              r={portRadius}
              fill={accent}
            />,
          )
        }
      }
      return (
        <g>
          <rect
            width={width}
            height={height}
            rx={12}
            ry={12}
            fill={fill}
            stroke={accent}
            stroke-width={1.6}
          />
          <rect
            width={width}
            height={26}
            rx={12}
            ry={12}
            fill={accent}
            opacity="0.16"
          />
          {stripes}
        </g>
      )
    }
    case "process":
      return (
        <rect
          width={width}
          height={height}
          rx={10}
          ry={10}
          fill={fill}
          stroke={accent}
          stroke-width={1.5}
        />
      )
    case "note":
    default:
      return (
        <rect
          width={width}
          height={height}
          rx={6}
          ry={6}
          fill={fill}
          stroke={accent}
          stroke-width={1.5}
        />
      )
  }
}

function nodeKindBadge(node: IllustrationNode): string {
  return NODE_TYPE_DEFAULTS[node.type].label
}

function wrapLines(text: string, maxPx: number): string[] {
  if (!text) return []
  const lines: string[] = []
  const explicitLines = text.split(/\r?\n/)
  const approxCharPx = 7
  const maxChars = Math.max(8, Math.floor(maxPx / approxCharPx))
  for (const explicit of explicitLines) {
    if (!explicit) continue
    const words = explicit.split(/\s+/)
    let current = ""
    for (const w of words) {
      if (!current) current = w
      else if (current.length + 1 + w.length <= maxChars) current += " " + w
      else {
        lines.push(current)
        current = w
      }
      if (lines.length >= 5) break
    }
    if (current && lines.length < 5) lines.push(current)
    if (lines.length >= 5) break
  }
  return lines.slice(0, 5)
}

function NodeContent({ node }: { node: IllustrationNode }) {
  const { width, height } = nodeSize(node)
  const accent = NODE_COLOR_ACCENTS[node.color]
  const lines = node.text.split(/\r?\n/).filter(Boolean)
  const primary = lines[0] ?? ""
  const secondary = lines.slice(1).join(" ")

  if (node.type === "label") {
    return (
      <text
        x={width / 2}
        y={height / 2 + 5}
        text-anchor="middle"
        class="illustration-board__label-text"
        fill="var(--dark)"
      >
        {primary || "Label"}
      </text>
    )
  }

  if (node.type === "decision") {
    const wrapped = wrapLines(node.text || "Decision", width * 0.55)
    return (
      <g>
        <text
          x={width / 2}
          y={height / 2 - (wrapped.length - 1) * 9 - 8}
          text-anchor="middle"
          class="illustration-board__kicker"
          fill={accent}
        >
          {nodeKindBadge(node)}
        </text>
        {wrapped.map((line, i) => (
          <text
            x={width / 2}
            y={height / 2 + i * 16}
            text-anchor="middle"
            class="illustration-board__node-text"
            fill="var(--dark)"
          >
            {line}
          </text>
        ))}
      </g>
    )
  }

  if (node.type === "lane" || node.type === "group" || node.type === "stack") {
    const headerWrapped = wrapLines(primary || nodeKindBadge(node), width - 24)
    return (
      <g>
        <text
          x={14}
          y={18}
          class="illustration-board__lane-title"
          fill="var(--dark)"
        >
          {headerWrapped[0] ?? nodeKindBadge(node)}
        </text>
        {node.type === "stack" && (
          <text
            x={width - 14}
            y={18}
            text-anchor="end"
            class="illustration-board__kicker"
            fill={accent}
          >
            ×{node.loopCount} · {node.ioPairs} io
          </text>
        )}
        {wrapLines(secondary, width - 28).map((line, i) => (
          <text
            x={14}
            y={48 + i * 16}
            class="illustration-board__node-text"
            fill="var(--darkgray)"
          >
            {line}
          </text>
        ))}
      </g>
    )
  }

  // Generic card layout: process / artifact / callout / note
  const titleWrapped = wrapLines(primary || nodeKindBadge(node), width - 28)
  const bodyWrapped = wrapLines(secondary, width - 28)
  return (
    <g>
      <text x={14} y={20} class="illustration-board__kicker" fill={accent}>
        {nodeKindBadge(node)}
      </text>
      <text x={14} y={42} class="illustration-board__node-title" fill="var(--dark)">
        {titleWrapped[0] ?? ""}
      </text>
      {bodyWrapped.map((line, i) => (
        <text
          x={14}
          y={64 + i * 16}
          class="illustration-board__node-text"
          fill="var(--darkgray)"
        >
          {line}
        </text>
      ))}
    </g>
  )
}

function Edge({
  edge,
  source,
  target,
}: {
  edge: IllustrationEdge
  source: IllustrationNode
  target: IllustrationNode
}) {
  const start = attachmentPoint(source, edge.sourceHandle, true)
  const end = attachmentPoint(target, edge.targetHandle, false)
  const path = bezierPath(start, end, edge.route ?? null)
  const stroke = edgeStrokeColor(edge)
  const label = branchLabel(edge)
  const mx = (start.x + end.x) / 2
  const my = (start.y + end.y) / 2
  const labelClass = isYesBranch(edge)
    ? "illustration-board__edge-label illustration-board__edge-label--yes"
    : isNoBranch(edge)
      ? "illustration-board__edge-label illustration-board__edge-label--no"
      : "illustration-board__edge-label"
  const markerId = isYesBranch(edge)
    ? "ill-arrow-yes"
    : isNoBranch(edge)
      ? "ill-arrow-no"
      : "ill-arrow"
  return (
    <g class="illustration-board__edge">
      <path d={path} fill="none" stroke={stroke} marker-end={`url(#${markerId})`} />
      {label && (
        <text x={mx} y={my - 6} text-anchor="middle" class={labelClass} fill={stroke}>
          {label}
        </text>
      )}
    </g>
  )
}

function Board({ initial, ctx }: BoardProps) {
  const [data, setData] = useState<IllustrationBoardData>(initial)
  const dataRef = useRef<IllustrationBoardData>(initial)
  dataRef.current = data
  const [drag, setDrag] = useState<DragState | null>(null)
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved" }
    | { kind: "error"; message: string }
  >({ kind: "idle" })

  const canEdit = ctx.capabilities.canWrite

  const bounds = useMemo(() => {
    let maxX = 800
    let maxY = 400
    for (const n of data.nodes) {
      const { width, height } = nodeSize(n)
      maxX = Math.max(maxX, n.x + width + 40)
      maxY = Math.max(maxY, n.y + height + 40)
    }
    return { width: maxX, height: maxY }
  }, [data])

  const nodeById = useMemo(() => {
    const m = new Map<string, IllustrationNode>()
    for (const n of data.nodes) m.set(n.id, n)
    return m
  }, [data])

  const onPointerDown = useCallback(
    (e: PointerEvent, node: IllustrationNode) => {
      if (!canEdit) return
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
      setDrag({
        id: node.id,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startNodeX: node.x,
        startNodeY: node.y,
      })
      e.preventDefault()
    },
    [canEdit],
  )

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!drag) return
      const dx = e.clientX - drag.startClientX
      const dy = e.clientY - drag.startClientY
      setData((d) => ({
        ...d,
        nodes: d.nodes.map((n) =>
          n.id === drag.id
            ? { ...n, x: Math.round(drag.startNodeX + dx), y: Math.round(drag.startNodeY + dy) }
            : n,
        ),
      }))
    },
    [drag],
  )

  const onPointerUp = useCallback(async () => {
    if (!drag) return
    const id = drag.id
    const startX = drag.startNodeX
    const startY = drag.startNodeY
    setDrag(null)
    const current = dataRef.current
    const idx = current.nodes.findIndex((n) => n.id === id)
    if (idx < 0) return
    const node = current.nodes[idx]
    if (node.x === startX && node.y === startY) return
    setStatus({ kind: "saving" })
    const result = await ctx.write({
      patch: [
        { op: "replace", path: `/nodes/${idx}/x`, value: node.x },
        { op: "replace", path: `/nodes/${idx}/y`, value: node.y },
      ],
    })
    if (result.ok) {
      setStatus({ kind: "saved" })
      setTimeout(() => setStatus({ kind: "idle" }), 1500)
    } else {
      setStatus({ kind: "error", message: result.error?.message ?? "write failed" })
      setData((d) => ({
        ...d,
        nodes: d.nodes.map((n) => (n.id === id ? { ...n, x: startX, y: startY } : n)),
      }))
    }
  }, [drag, ctx])

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => onPointerMove(e)
    const up = () => onPointerUp()
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
  }, [drag, onPointerMove, onPointerUp])

  return (
    <div class="illustration-board" data-edit={canEdit ? "1" : "0"}>
      <div class="illustration-board__chrome">
        <span class="illustration-board__title">Illustration board</span>
        <span class="illustration-board__mode">{ctx.mode}</span>
        <span class={`illustration-board__status illustration-board__status--${status.kind}`}>
          {status.kind === "saving" && "Saving…"}
          {status.kind === "saved" && "Saved"}
          {status.kind === "error" && `Error: ${status.message}`}
          {status.kind === "idle" && (canEdit ? "Drag nodes to reposition" : "Read-only")}
        </span>
      </div>
      <div class="illustration-board__canvas">
        <svg
          viewBox={`0 0 ${bounds.width} ${bounds.height}`}
          width={bounds.width}
          height={bounds.height}
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <marker
              id="ill-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={NODE_COLOR_ACCENTS.slate} />
            </marker>
            <marker
              id="ill-arrow-yes"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={BRANCH_YES_COLOR} />
            </marker>
            <marker
              id="ill-arrow-no"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={BRANCH_NO_COLOR} />
            </marker>
          </defs>
          <g class="illustration-board__edges">
            {data.edges.map((edge) => {
              const source = nodeById.get(edge.source)
              const target = nodeById.get(edge.target)
              if (!source || !target) return null
              return <Edge edge={edge} source={source} target={target} key={edge.id} />
            })}
          </g>
          <g class="illustration-board__nodes">
            {data.nodes.map((node) => (
              <g
                key={node.id}
                class={`illustration-board__node illustration-board__node--${node.color} illustration-board__node--type-${node.type}`}
                transform={`translate(${node.x},${node.y})`}
                data-node-id={node.id}
                data-draggable={canEdit ? "1" : "0"}
                onPointerDown={(e: PointerEvent) => onPointerDown(e, node)}
              >
                <NodeShape node={node} />
                <NodeContent node={node} />
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  )
}

export function mountIllustrationBoard(
  ctx: WidgetMountContext<IllustrationBoardData>,
): () => void {
  render(<Board initial={ctx.data} ctx={ctx} />, ctx.el)
  return () => {
    render(null, ctx.el)
  }
}
