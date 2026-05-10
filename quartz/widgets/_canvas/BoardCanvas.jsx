/** @jsxRuntime automatic @jsxImportSource react */
import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  ConnectionMode,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react'
import { Trash2, LayoutDashboard } from 'lucide-react'
import { nodeTypes, CanvasSmoothEdge, CanvasConnectionLine } from './components.jsx'
import { getIllustrationEdgeColor } from './illustrationEdgeModel.js'
import { ILLUSTRATION_NODE_TYPE_META } from './illustration-helpers.js'
import { computeIllustrationSmartLayout } from './layout.js'
import { ILLUSTRATION_PALETTE } from './palettes.js'

const edgeTypes = {
  canvasSmoothEdge: CanvasSmoothEdge,
}

// Module-level stable identity. Passing `proOptions={{ ... }}` inline would
// allocate a fresh object every render and tickle React Flow's prop-change
// detection, which (in v12) re-evaluates viewport bookkeeping. Pin it once.
const PRO_OPTIONS = { hideAttribution: true }
const DEFAULT_FIT_VIEW_OPTIONS = { padding: 0.15, duration: 0 }
// Stable initial viewport. We don't pass `fitView` as a prop anymore — see
// the onInit handler — so RF needs an explicit starting point to render
// against on mount and (more importantly) on container resize.
const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 }

function nodeSize(node) {
  const meta = ILLUSTRATION_NODE_TYPE_META[node.type] || ILLUSTRATION_NODE_TYPE_META.note
  return {
    width: node.width || meta.width,
    height: node.height || meta.height,
  }
}

function buildChildIndexes(nodes) {
  const childrenByContainer = new Map()
  for (const n of nodes) {
    if (n.containerId) {
      const arr = childrenByContainer.get(n.containerId) || []
      arr.push(n)
      childrenByContainer.set(n.containerId, arr)
    }
  }
  return { childrenByContainer }
}

function toFlowNodes(nodes, editable, selectedNodeId, childrenByContainer) {
  const containerIds = new Set(
    nodes.filter((n) => n.type === 'lane' || n.type === 'group' || n.type === 'stack').map((n) => n.id),
  )
  return nodes.map((n) => {
    const { width, height } = nodeSize(n)
    const inContainer = n.containerId && containerIds.has(n.containerId)
    return {
      id: n.id,
      type: 'illustrationNode',
      position: { x: n.x, y: n.y },
      width,
      height,
      style: { width, height },
      draggable: editable,
      selectable: true,
      selected: n.id === selectedNodeId,
      parentId: inContainer ? n.containerId : undefined,
      extent: inContainer ? 'parent' : undefined,
      data: {
        illustrationType: n.type,
        color: n.color,
        text: n.text,
        width,
        height,
        containerId: n.containerId || '',
        ioPairs: n.ioPairs,
        loopCount: n.loopCount,
        graphEditable: editable,
        isSelected: n.id === selectedNodeId,
        stackChildren: n.type === 'stack' ? childrenByContainer.get(n.id) || [] : [],
        stackInternalEdges: [],
        selectedEdgeId: '',
        onSelectEdge: () => {},
        onEdgeContextMenu: () => {},
      },
    }
  })
}

function toFlowEdges(edges, selectedEdgeId) {
  return edges.map((e) => {
    const stroke = getIllustrationEdgeColor(e.color)
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle || undefined,
      targetHandle: e.targetHandle || undefined,
      type: 'canvasSmoothEdge',
      label: e.label || undefined,
      selected: e.id === selectedEdgeId,
      style: {
        stroke,
        strokeWidth: e.id === selectedEdgeId ? 2.6 : 1.6,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 18, height: 18 },
    }
  })
}

function newEdgeId() {
  return `illustration-edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function newNodeId() {
  return `illustration-node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Field-by-field equality for the slice of a React Flow node that affects
// rendering. Anything else (extent, parentId, etc.) is recomputed
// deterministically from the same inputs, so it's safe to compare just
// these — if they match, the entire object can be reused.
function flowNodeEqual(a, b) {
  if (a.id !== b.id) return false
  if (a.position.x !== b.position.x || a.position.y !== b.position.y) return false
  if (a.width !== b.width || a.height !== b.height) return false
  if (a.draggable !== b.draggable) return false
  if (a.parentId !== b.parentId) return false
  const ad = a.data, bd = b.data
  return (
    ad.illustrationType === bd.illustrationType &&
    ad.color === bd.color &&
    ad.text === bd.text &&
    ad.width === bd.width &&
    ad.height === bd.height &&
    ad.containerId === bd.containerId &&
    ad.ioPairs === bd.ioPairs &&
    ad.loopCount === bd.loopCount &&
    ad.graphEditable === bd.graphEditable
  )
}

function flowEdgeEqual(a, b) {
  if (a.id !== b.id) return false
  if (a.source !== b.source || a.target !== b.target) return false
  if (a.sourceHandle !== b.sourceHandle || a.targetHandle !== b.targetHandle) return false
  if (a.label !== b.label) return false
  if ((a.style?.stroke ?? "") !== (b.style?.stroke ?? "")) return false
  return true
}

// Returns either `cur` (no change at all — caller bails) or a new array
// built from `next` but reusing each unchanged entry's identity.
function reconcileNodes(cur, next) {
  if (cur.length !== next.length) return next
  let anyChanged = false
  const byId = new Map(cur.map((n) => [n.id, n]))
  const merged = next.map((n) => {
    const prev = byId.get(n.id)
    if (prev && flowNodeEqual(prev, n)) return prev
    anyChanged = true
    return n
  })
  return anyChanged ? merged : cur
}

function reconcileEdges(cur, next) {
  if (cur.length !== next.length) return next
  let anyChanged = false
  const byId = new Map(cur.map((e) => [e.id, e]))
  const merged = next.map((e) => {
    const prev = byId.get(e.id)
    if (prev && flowEdgeEqual(prev, e)) return prev
    anyChanged = true
    return e
  })
  return anyChanged ? merged : cur
}

function makeNode(palette, position) {
  // palette.visual is set by widgets whose `type` is non-visual (workflow:
  // type=call/llm/branch/...). Fall back to palette.type for plain
  // illustration palettes where type IS the visual kind.
  const visualType = palette.visual || palette.type
  const meta = ILLUSTRATION_NODE_TYPE_META[visualType] || ILLUSTRATION_NODE_TYPE_META.note
  return {
    id: newNodeId(),
    type: visualType,
    containerId: '',
    x: Math.round(position.x),
    y: Math.round(position.y),
    width: meta.width,
    height: meta.height,
    text: palette.defaultText,
    color: palette.color,
    ioPairs: 1,
    loopCount: 1,
  }
}

function makeEdge(connection) {
  const sourceHandle = String(connection.sourceHandle || '').trim()
  const label =
    sourceHandle === 'source-top'
      ? 'Yes'
      : sourceHandle === 'source-bottom'
        ? 'No'
        : ''
  return {
    id: newEdgeId(),
    type: 'arrow',
    source: String(connection.source || '').trim(),
    target: String(connection.target || '').trim(),
    sourceHandle,
    targetHandle: String(connection.targetHandle || '').trim(),
    label,
    color: 'slate',
    route: null,
  }
}

export default function BoardCanvas({
  data,
  mode,
  onChange,
  palette = ILLUSTRATION_PALETTE,
  extraToolbarRight = null,
}) {
  const editable = mode === 'live'
  const [selectedNodeId, setSelectedNodeId] = useState('')
  const [selectedEdgeId, setSelectedEdgeId] = useState('')
  const [reactFlowInstance, setReactFlowInstance] = useState(null)
  const [layoutBusy, setLayoutBusy] = useState(false)

  // Pin the children index to data.nodes (not the whole data object) so it
  // doesn't churn just because edges changed.
  const indexes = useMemo(() => buildChildIndexes(data.nodes), [data.nodes])

  // React Flow's nodes/edges state is local — drives interactions like drag,
  // selection, hover. The authoritative state is `data` from props; on each
  // interaction we either compute a JSON Patch or do a local-only mutation.
  const [nodes, setNodes] = useState(() => toFlowNodes(data.nodes, editable, '', indexes.childrenByContainer))
  const [edges, setEdges] = useState(() => toFlowEdges(data.edges, ''))

  // Reproject ONLY when external data changes (e.g., after a save committed
  // upstream). Selection state and `editable` are deliberately not in the
  // dep list — they're handled by the targeted selection effect below.
  //
  // Identity-stable reconciler: for each node in the new projection, look
  // up the corresponding existing node in our state. If every visible
  // field is identical, reuse the existing object so React Flow sees the
  // same reference and skips the per-node re-render. The "refresh on
  // drag-stop" complaint came from rebuilding every node object on every
  // patch round-trip — even when positions matched what React Flow's
  // internal drag handler had already written. With this reconciler, a
  // pure drag-stop produces a node array that is structurally identical
  // to current state and we bail out without setNodes.
  useEffect(() => {
    const projectedNodes = toFlowNodes(data.nodes, editable, selectedNodeId, indexes.childrenByContainer)
    const projectedEdges = toFlowEdges(data.edges, selectedEdgeId)
    setNodes((cur) => reconcileNodes(cur, projectedNodes))
    setEdges((cur) => reconcileEdges(cur, projectedEdges))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nodes, data.edges, editable, indexes])

  // Selection-only updates: flip the `selected` flag (and the corresponding
  // `data.isSelected` consumed by the per-type node renderer) without
  // rebuilding the node array. Cheap, keeps React Flow's internal node
  // positions intact during a drag.
  useEffect(() => {
    setNodes((cur) =>
      cur.map((n) => {
        const isSel = n.id === selectedNodeId
        if (n.selected === isSel && n.data.isSelected === isSel) return n
        return { ...n, selected: isSel, data: { ...n.data, isSelected: isSel } }
      }),
    )
    setEdges((cur) =>
      cur.map((e) => {
        const isSel = e.id === selectedEdgeId
        if (e.selected === isSel) return e
        return {
          ...e,
          selected: isSel,
          style: { ...e.style, strokeWidth: isSel ? 2.6 : 1.6 },
        }
      }),
    )
  }, [selectedNodeId, selectedEdgeId])

  const onNodesChange = useCallback((changes) => {
    setNodes((cur) => applyNodeChanges(changes, cur))
  }, [])

  const onEdgesChange = useCallback((changes) => {
    setEdges((cur) => applyEdgeChanges(changes, cur))
  }, [])

  const onNodeDragStop = useCallback(
    (_event, node) => {
      if (!editable || !onChange) return
      const idx = data.nodes.findIndex((n) => n.id === node.id)
      if (idx < 0) return
      const x = Math.round(node.position.x)
      const y = Math.round(node.position.y)
      const prev = data.nodes[idx]
      if (prev.x === x && prev.y === y) return
      onChange([
        { op: 'replace', path: `/nodes/${idx}/x`, value: x },
        { op: 'replace', path: `/nodes/${idx}/y`, value: y },
      ])
    },
    [data, editable, onChange],
  )

  const onConnect = useCallback(
    (connection) => {
      if (!editable || !onChange) return
      if (!connection.source || !connection.target) return
      if (connection.source === connection.target) return
      const edge = makeEdge(connection)
      onChange([{ op: 'add', path: '/edges/-', value: edge }])
      setSelectedEdgeId(edge.id)
    },
    [editable, onChange],
  )

  const onSelectionChange = useCallback(({ nodes: selNodes, edges: selEdges }) => {
    setSelectedNodeId(selNodes && selNodes.length ? selNodes[0].id : '')
    setSelectedEdgeId(selEdges && selEdges.length ? selEdges[0].id : '')
  }, [])

  const deleteSelection = useCallback(() => {
    if (!editable || !onChange) return
    const ops = []
    if (selectedEdgeId) {
      const idx = data.edges.findIndex((e) => e.id === selectedEdgeId)
      if (idx >= 0) ops.push({ op: 'remove', path: `/edges/${idx}` })
    }
    if (selectedNodeId) {
      // Remove dependent edges first (in descending order so indexes stay valid),
      // then the node itself.
      const incidentIdx = []
      data.edges.forEach((e, i) => {
        if (e.source === selectedNodeId || e.target === selectedNodeId) incidentIdx.push(i)
      })
      incidentIdx.sort((a, b) => b - a).forEach((i) => ops.push({ op: 'remove', path: `/edges/${i}` }))
      const nodeIdx = data.nodes.findIndex((n) => n.id === selectedNodeId)
      if (nodeIdx >= 0) ops.push({ op: 'remove', path: `/nodes/${nodeIdx}` })
    }
    if (ops.length === 0) return
    onChange(ops)
    setSelectedEdgeId('')
    setSelectedNodeId('')
  }, [editable, onChange, selectedNodeId, selectedEdgeId, data])

  // Keyboard delete handler. Scoped to the canvas root via tabIndex/focus.
  const containerRef = useRef(null)
  useEffect(() => {
    if (!editable) return
    const handler = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const target = e.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
      }
      if (!selectedNodeId && !selectedEdgeId) return
      if (!containerRef.current) return
      // Only act when the canvas (or one of its descendants) has focus or
      // contains the active element.
      const active = document.activeElement
      if (!containerRef.current.contains(active) && active !== document.body) return
      e.preventDefault()
      deleteSelection()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [editable, selectedNodeId, selectedEdgeId, deleteSelection])

  const addNode = useCallback(
    (palette) => {
      if (!editable || !onChange) return
      // Drop the new node near the current viewport center so it's visible.
      let position = { x: 80, y: 80 }
      if (reactFlowInstance && typeof reactFlowInstance.screenToFlowPosition === 'function') {
        const rect = containerRef.current?.getBoundingClientRect()
        if (rect) {
          position = reactFlowInstance.screenToFlowPosition({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          })
        }
      }
      const node = makeNode(palette, position)
      onChange([{ op: 'add', path: '/nodes/-', value: node }])
      setSelectedNodeId(node.id)
      setSelectedEdgeId('')
    },
    [editable, onChange, reactFlowInstance],
  )

  const runLayout = useCallback(async () => {
    if (!editable || !onChange || layoutBusy) return
    setLayoutBusy(true)
    try {
      const next = await computeIllustrationSmartLayout({
        nodes: data.nodes,
        edges: data.edges,
      })
      // Emit per-field replace ops instead of a wholesale `replace /nodes`.
      // Wholesale replace would clobber widget-specific fields (workflow's
      // kind/op/params/outputs, future widgets' extras) since our layout
      // function only knows about visual fields. Fine-grained patches keep
      // those untouched.
      const ops = []
      for (let i = 0; i < data.nodes.length; i++) {
        const oldNode = data.nodes[i]
        const newNode = next.nodes.find((n) => n.id === oldNode.id)
        if (!newNode) continue
        if (newNode.x !== oldNode.x) ops.push({ op: 'replace', path: `/nodes/${i}/x`, value: newNode.x })
        if (newNode.y !== oldNode.y) ops.push({ op: 'replace', path: `/nodes/${i}/y`, value: newNode.y })
        const oldW = oldNode.width
        const newW = newNode.width
        if (Number.isFinite(newW) && newW !== oldW) {
          ops.push({ op: 'replace', path: `/nodes/${i}/width`, value: newW })
        }
        const oldH = oldNode.height
        const newH = newNode.height
        if (Number.isFinite(newH) && newH !== oldH) {
          ops.push({ op: 'replace', path: `/nodes/${i}/height`, value: newH })
        }
      }
      if (ops.length > 0) onChange(ops)
      window.setTimeout(() => {
        if (reactFlowInstance && typeof reactFlowInstance.fitView === 'function') {
          reactFlowInstance.fitView({ padding: 0.18, duration: 260 })
        }
      }, 50)
    } catch (e) {
      console.warn('[illustration] auto layout failed', e)
    } finally {
      setLayoutBusy(false)
    }
  }, [editable, onChange, layoutBusy, data, reactFlowInstance])

  // Diagnostic hook — same as before, gates on editable mode.
  const dataRef = useRef(data)
  dataRef.current = data
  useEffect(() => {
    if (!editable || !onChange) return
    const move = (idx, x, y) => {
      const d = dataRef.current
      if (idx < 0 || idx >= d.nodes.length) return false
      onChange([
        { op: 'replace', path: `/nodes/${idx}/x`, value: x },
        { op: 'replace', path: `/nodes/${idx}/y`, value: y },
      ])
      return true
    }
    if (typeof window !== 'undefined') {
      window.__illustrationDebugMove = move
      window.__illustrationDebugAdd = (paletteId) => {
        const entry = palette.find((p) => p.type === paletteId) || palette[0]
        addNode(entry)
        return true
      }
      window.__illustrationDebugDelete = () => {
        deleteSelection()
        return true
      }
      window.__illustrationDebugLayout = () => runLayout()
    }
    return () => {
      if (typeof window !== 'undefined') {
        delete window.__illustrationDebugMove
        delete window.__illustrationDebugAdd
        delete window.__illustrationDebugDelete
        delete window.__illustrationDebugLayout
      }
    }
  }, [editable, onChange, addNode, deleteSelection, runLayout])

  return (
    <div ref={containerRef} className="illustration-board__rf-host" tabIndex={-1}>
      {editable ? (
        <div className="illustration-board__toolbar">
          <div className="illustration-board__toolbar-group">
            {palette.map((p) => (
              <button
                key={p.type}
                type="button"
                className={`illustration-board__toolbar-btn illustration-board__toolbar-btn--accent-${p.color}`}
                onClick={() => addNode(p)}
                title={`Add ${p.label.toLowerCase()}`}
                aria-label={`Add ${p.label.toLowerCase()}`}
              >
                <p.Icon size={14} strokeWidth={2.2} />
                <span>{p.label}</span>
              </button>
            ))}
          </div>
          <div className="illustration-board__toolbar-group illustration-board__toolbar-group--right">
            {extraToolbarRight}
            <button
              type="button"
              className="illustration-board__toolbar-btn"
              onClick={runLayout}
              disabled={layoutBusy}
              title="Auto-layout via ELK"
            >
              <LayoutDashboard size={14} strokeWidth={2.2} />
              <span>{layoutBusy ? 'Laying out…' : 'Layout'}</span>
            </button>
            <button
              type="button"
              className="illustration-board__toolbar-btn illustration-board__toolbar-btn--danger"
              onClick={deleteSelection}
              disabled={!selectedNodeId && !selectedEdgeId}
              title="Delete selected (Del)"
            >
              <Trash2 size={14} strokeWidth={2.2} />
              <span>Delete</span>
            </button>
          </div>
        </div>
      ) : null}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionLineComponent={CanvasConnectionLine}
        connectionMode={ConnectionMode.Strict}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={(e, n) => {
          if (typeof window !== 'undefined') {
            ;(window.__rfEvents ||= []).push({ t: performance.now() | 0, kind: 'dragstop', id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y) })
          }
          onNodeDragStop(e, n)
        }}
        onNodeDragStart={(_e, n) => {
          if (typeof window !== 'undefined') {
            ;(window.__rfEvents ||= []).push({ t: performance.now() | 0, kind: 'dragstart', id: n.id })
          }
        }}
        onNodeDrag={(_e, n) => {
          if (typeof window !== 'undefined') {
            ;(window.__rfEvents ||= []).push({ t: performance.now() | 0, kind: 'drag', id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y) })
          }
        }}
        onConnect={onConnect}
        onSelectionChange={onSelectionChange}
        onInit={(instance) => {
          // Capture the instance AND run a one-shot fit. Using onInit
          // instead of the `fitView` boolean prop avoids React Flow's
          // ResizeObserver-driven refits on container resize, which was
          // the source of the canvas flicker the user reported when the
          // viewport changed size.
          setReactFlowInstance(instance)
          if (typeof instance.fitView === "function") {
            // Defer one frame so the container has its final width before
            // we compute the fit transform.
            requestAnimationFrame(() => instance.fitView(DEFAULT_FIT_VIEW_OPTIONS))
          }
        }}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        panOnDrag
        zoomOnScroll
        defaultViewport={DEFAULT_VIEWPORT}
        fitViewOptions={DEFAULT_FIT_VIEW_OPTIONS}
        proOptions={PRO_OPTIONS}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
