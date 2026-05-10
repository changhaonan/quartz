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
import { Plus, Trash2, GitBranch, FileText, Play, MessageSquareQuote, Box, Tag, Workflow, LayoutDashboard } from 'lucide-react'
import { nodeTypes, CanvasSmoothEdge, CanvasConnectionLine } from './components.jsx'
import { getIllustrationEdgeColor } from './illustrationEdgeModel.js'
import { ILLUSTRATION_NODE_TYPE_META, ILLUSTRATION_COLOR_OPTIONS } from './illustration-helpers.js'
import { computeIllustrationSmartLayout } from './layout.js'

const edgeTypes = {
  canvasSmoothEdge: CanvasSmoothEdge,
}

// Mapping for the floating "+ node" palette. Order matters — first item is
// the default for keyboard shortcuts. Mirrors bridge's defaults so a board
// authored in either tool ends up visually identical.
const PALETTE = [
  { type: 'note', label: 'Note', color: 'amber', Icon: MessageSquareQuote, defaultText: 'New note' },
  { type: 'process', label: 'Process', color: 'cyan', Icon: Play, defaultText: 'Process step' },
  { type: 'decision', label: 'Decision', color: 'rose', Icon: GitBranch, defaultText: 'Decision / gate' },
  { type: 'artifact', label: 'Artifact', color: 'violet', Icon: FileText, defaultText: 'Artifact / output' },
  { type: 'stack', label: 'Stack', color: 'violet', Icon: Workflow, defaultText: 'Stack\nRepeated block' },
  { type: 'lane', label: 'Lane', color: 'mint', Icon: Box, defaultText: 'Lane / phase' },
  { type: 'callout', label: 'Callout', color: 'amber', Icon: MessageSquareQuote, defaultText: 'Context note' },
  { type: 'label', label: 'Label', color: 'mint', Icon: Tag, defaultText: 'Flow label' },
]

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

function makeNode(palette, position) {
  const meta = ILLUSTRATION_NODE_TYPE_META[palette.type]
  return {
    id: newNodeId(),
    type: palette.type,
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

export default function IllustrationCanvas({ data, mode, onChange }) {
  const editable = mode === 'live'
  const [selectedNodeId, setSelectedNodeId] = useState('')
  const [selectedEdgeId, setSelectedEdgeId] = useState('')
  const [reactFlowInstance, setReactFlowInstance] = useState(null)
  const [layoutBusy, setLayoutBusy] = useState(false)

  const indexes = useMemo(() => buildChildIndexes(data.nodes), [data])

  // React Flow's nodes/edges state is local — drives interactions like drag,
  // selection, hover. The authoritative state is `data` from props; on each
  // interaction we either compute a JSON Patch or do a local-only mutation.
  const [nodes, setNodes] = useState(() => toFlowNodes(data.nodes, editable, '', indexes.childrenByContainer))
  const [edges, setEdges] = useState(() => toFlowEdges(data.edges, ''))

  useEffect(() => {
    setNodes(toFlowNodes(data.nodes, editable, selectedNodeId, indexes.childrenByContainer))
    setEdges(toFlowEdges(data.edges, selectedEdgeId))
  }, [data, editable, selectedNodeId, selectedEdgeId, indexes])

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
      onChange([
        { op: 'replace', path: '/nodes', value: next.nodes },
        { op: 'replace', path: '/edges', value: next.edges },
      ])
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
        const palette = PALETTE.find((p) => p.type === paletteId) || PALETTE[0]
        addNode(palette)
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
            {PALETTE.map((p) => (
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
        onInit={setReactFlowInstance}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        panOnDrag
        zoomOnScroll
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
