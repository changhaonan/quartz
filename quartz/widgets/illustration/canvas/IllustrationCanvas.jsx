/** @jsxRuntime automatic @jsxImportSource react */
import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { ReactFlow, Background, Controls, MarkerType } from '@xyflow/react'
import { nodeTypes, CanvasSmoothEdge, CanvasConnectionLine } from './components.jsx'
import { getIllustrationEdgeColor } from './illustrationEdgeModel.js'
import { ILLUSTRATION_NODE_TYPE_META } from './illustration-helpers.js'

const edgeTypes = {
  canvasSmoothEdge: CanvasSmoothEdge,
}

function nodeSize(node) {
  const meta = ILLUSTRATION_NODE_TYPE_META[node.type] || ILLUSTRATION_NODE_TYPE_META.note
  return {
    width: node.width || meta.width,
    height: node.height || meta.height,
  }
}

function buildChildIndexes(nodes) {
  const childrenByContainer = new Map()
  const stackInternalEdges = new Map()
  for (const n of nodes) {
    if (n.containerId) {
      const arr = childrenByContainer.get(n.containerId) || []
      arr.push(n)
      childrenByContainer.set(n.containerId, arr)
    }
  }
  return { childrenByContainer, stackInternalEdges }
}

function toFlowNodes(nodes, editable, childrenByContainer) {
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
        isSelected: false,
        stackChildren: n.type === 'stack' ? childrenByContainer.get(n.id) || [] : [],
        stackInternalEdges: [],
        selectedEdgeId: '',
        onSelectEdge: () => {},
        onEdgeContextMenu: () => {},
      },
    }
  })
}

function toFlowEdges(edges) {
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
      style: { stroke, strokeWidth: 1.6 },
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 18, height: 18 },
    }
  })
}

export default function IllustrationCanvas({ data, mode, onNodeMove }) {
  const editable = mode === 'live'
  const initialIndexes = useMemo(() => buildChildIndexes(data.nodes), [data])
  const [nodes, setNodes] = useState(() =>
    toFlowNodes(data.nodes, editable, initialIndexes.childrenByContainer),
  )
  const [edges, setEdges] = useState(() => toFlowEdges(data.edges))

  // External data refresh: rebuild flow nodes/edges when parent re-renders
  // with new data (after a successful write triggers a refresh).
  useEffect(() => {
    const idx = buildChildIndexes(data.nodes)
    setNodes(toFlowNodes(data.nodes, editable, idx.childrenByContainer))
    setEdges(toFlowEdges(data.edges))
  }, [data, editable])

  const onNodesChange = useCallback((changes) => {
    setNodes((current) => {
      let next = current
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          next = next.map((n) =>
            n.id === change.id ? { ...n, position: change.position } : n,
          )
        }
        if (change.type === 'select') {
          next = next.map((n) =>
            n.id === change.id
              ? { ...n, data: { ...n.data, isSelected: change.selected } }
              : n,
          )
        }
      }
      return next
    })
  }, [])

  const onNodeDragStop = useCallback(
    (_event, node) => {
      if (!editable || !onNodeMove) return
      const original = data.nodes.findIndex((n) => n.id === node.id)
      if (original < 0) return
      const x = Math.round(node.position.x)
      const y = Math.round(node.position.y)
      const prev = data.nodes[original]
      if (prev.x === x && prev.y === y) return
      onNodeMove({ id: node.id, index: original, x, y })
    },
    [data, editable, onNodeMove],
  )

  // Diagnostic hook: lets headless probes trigger a save without going
  // through React Flow's pointer-event-based drag (which isn't reliably
  // dispatchable from playwright). Safe to leave in: it's gated by a
  // global property nothing else writes to and runs the same path drag
  // would.
  const dataRef = useRef(data)
  dataRef.current = data
  useEffect(() => {
    if (!editable || !onNodeMove) return
    const hook = (idx, x, y) => {
      const d = dataRef.current
      if (idx < 0 || idx >= d.nodes.length) return false
      const node = d.nodes[idx]
      onNodeMove({ id: node.id, index: idx, x, y })
      return true
    }
    if (typeof window !== "undefined") {
      window.__illustrationDebugMove = hook
    }
    return () => {
      if (typeof window !== "undefined" && window.__illustrationDebugMove === hook) {
        delete window.__illustrationDebugMove
      }
    }
  }, [editable, onNodeMove])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      connectionLineComponent={CanvasConnectionLine}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      nodesDraggable={editable}
      nodesConnectable={false}
      elementsSelectable
      panOnDrag
      zoomOnScroll
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}
