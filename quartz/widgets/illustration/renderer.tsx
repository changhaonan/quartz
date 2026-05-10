import { render } from "preact"
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks"
import type { WidgetMountContext } from "../types"
import {
  IllustrationBoardData,
  IllustrationEdge,
  IllustrationNode,
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

function nodeCenter(n: IllustrationNode) {
  return { cx: n.x + n.width / 2, cy: n.y + n.height / 2 }
}

function clipEdgeToRect(
  cx: number,
  cy: number,
  tx: number,
  ty: number,
  rw: number,
  rh: number,
): { x: number; y: number } {
  const dx = tx - cx
  const dy = ty - cy
  if (dx === 0 && dy === 0) return { x: tx, y: ty }
  const halfW = rw / 2
  const halfH = rh / 2
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  const scale = ax * halfH > ay * halfW ? halfW / ax : halfH / ay
  return { x: tx - dx * scale, y: ty - dy * scale }
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
      maxX = Math.max(maxX, n.x + n.width + 40)
      maxY = Math.max(maxY, n.y + n.height + 40)
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

  const onPointerUp = useCallback(
    async (_e: PointerEvent) => {
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
        setStatus({
          kind: "error",
          message: result.error?.message ?? "write failed",
        })
        setData((d) => ({
          ...d,
          nodes: d.nodes.map((n) =>
            n.id === id ? { ...n, x: startX, y: startY } : n,
          ),
        }))
      }
    },
    [drag, ctx],
  )

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => onPointerMove(e)
    const up = (e: PointerEvent) => onPointerUp(e)
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
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          </defs>
          <g class="illustration-board__edges">
            {data.edges.map((edge) => renderEdge(edge, nodeById))}
          </g>
          <g class="illustration-board__nodes">
            {data.nodes.map((node) => (
              <g
                key={node.id}
                class={`illustration-board__node illustration-board__node--${node.color} illustration-board__node--${node.type}`}
                transform={`translate(${node.x},${node.y})`}
                data-node-id={node.id}
                data-draggable={canEdit ? "1" : "0"}
                onPointerDown={(e: PointerEvent) => onPointerDown(e, node)}
              >
                <rect
                  width={node.width}
                  height={node.height}
                  rx={10}
                  ry={10}
                  class="illustration-board__node-rect"
                />
                <text
                  x={16}
                  y={26}
                  class="illustration-board__node-title"
                >
                  {node.title}
                </text>
                {wrapText(node.text, node.width - 32).map((line, i) => (
                  <text
                    x={16}
                    y={50 + i * 18}
                    class="illustration-board__node-text"
                  >
                    {line}
                  </text>
                ))}
                <text
                  x={node.width - 12}
                  y={node.height - 10}
                  class="illustration-board__node-kind"
                  text-anchor="end"
                >
                  {node.type}
                </text>
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  )
}

function renderEdge(edge: IllustrationEdge, nodeById: Map<string, IllustrationNode>) {
  const a = nodeById.get(edge.source)
  const b = nodeById.get(edge.target)
  if (!a || !b) return null
  const ca = nodeCenter(a)
  const cb = nodeCenter(b)
  const start = clipEdgeToRect(cb.cx, cb.cy, ca.cx, ca.cy, a.width, a.height)
  const end = clipEdgeToRect(ca.cx, ca.cy, cb.cx, cb.cy, b.width, b.height)
  const mx = (start.x + end.x) / 2
  const my = (start.y + end.y) / 2
  return (
    <g key={edge.id} class="illustration-board__edge">
      <line
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        marker-end="url(#ill-arrow)"
      />
      {edge.label && (
        <text x={mx} y={my - 6} class="illustration-board__edge-label" text-anchor="middle">
          {edge.label}
        </text>
      )}
    </g>
  )
}

function wrapText(text: string, maxPx: number): string[] {
  if (!text) return []
  const approxCharPx = 7
  const maxChars = Math.max(8, Math.floor(maxPx / approxCharPx))
  const words = text.split(/\s+/)
  const lines: string[] = []
  let current = ""
  for (const w of words) {
    if (!current) {
      current = w
    } else if (current.length + 1 + w.length <= maxChars) {
      current += " " + w
    } else {
      lines.push(current)
      current = w
    }
    if (lines.length >= 4) break
  }
  if (current && lines.length < 4) lines.push(current)
  return lines.slice(0, 4)
}

export function mountIllustrationBoard(
  ctx: WidgetMountContext<IllustrationBoardData>,
): () => void {
  render(<Board initial={ctx.data} ctx={ctx} />, ctx.el)
  return () => {
    render(null, ctx.el)
  }
}
