/** @jsxRuntime automatic @jsxImportSource react */
// Ported from claude_pty/client/src/blueprint/canvas/components.jsx with
// ticket/blueprint pieces removed (TicketNode, displayTicketClass,
// ChildTicketModal, TicketDetailDrawer, CanvasTicketSidebar). Keep this
// file close to the upstream so future bridge fixes can be re-applied
// with minimal drift.

import React from 'react'
import { BaseEdge, getSmoothStepPath, Handle, Position } from '@xyflow/react'
import { Box, FileText, GitBranch, MessageSquareQuote, Play, Tag, Workflow } from 'lucide-react'
import {
  ILLUSTRATION_COLOR_OPTIONS,
  ILLUSTRATION_NODE_TYPE_META,
  illustrationColorMeta,
} from './illustration-helpers.js'
import { CHILD_DIFFICULTY_OPTIONS, EDGE_TYPES } from './constants.js'
import {
  createIllustrationEdgeView,
  createIllustrationNodeMap,
} from './illustrationEdgeModel.js'

function shortTicketId(id) {
  const value = String(id || '').trim()
  return value.length > 12 ? `${value.slice(0, 10)}…` : value
}

const STACK_PORT_LAYOUT = {
  railWidth: 40,
  railOffset: -10,
  innerCenter: 20,
  outerLeftCenter: 0,
  outerRightCenter: 40,
  topStart: 96,
  topSpan: 148,
  maxGap: 44,
};

function stackPortCenterX(side, kind, width) {
  if (side === 'left') {
    return kind === 'outer'
      ? STACK_PORT_LAYOUT.railOffset + STACK_PORT_LAYOUT.outerLeftCenter
      : STACK_PORT_LAYOUT.railOffset + STACK_PORT_LAYOUT.innerCenter;
  }
  return kind === 'outer'
    ? width + STACK_PORT_LAYOUT.railOffset + STACK_PORT_LAYOUT.outerRightCenter
    : width + STACK_PORT_LAYOUT.railOffset + STACK_PORT_LAYOUT.innerCenter;
}

function stackPortPairY(pairIndex, ioPairs) {
  const count = Math.max(1, Math.min(6, Number(ioPairs || 1)));
  const gap = count > 1 ? Math.min(STACK_PORT_LAYOUT.maxGap, STACK_PORT_LAYOUT.topSpan / (count - 1)) : 0;
  return STACK_PORT_LAYOUT.topStart + (pairIndex * gap);
}

function stackPortHandleStyle(side, kind) {
  const isLeft = side === 'left';
  const centerX = isLeft
    ? kind === 'outer'
      ? STACK_PORT_LAYOUT.outerLeftCenter
      : STACK_PORT_LAYOUT.innerCenter
    : kind === 'outer'
      ? STACK_PORT_LAYOUT.outerRightCenter
      : STACK_PORT_LAYOUT.innerCenter;
  return {
    left: `${centerX}px`,
    top: '50%',
    transform: 'translate(-50%, -50%)',
  };
}

function stackPortGlyphStyle(side, kind) {
  return stackPortHandleStyle(side, kind);
}

function StackPortRail({
  side,
  top,
  pairIndex,
  graphEditable,
}) {
  const isLeft = side === 'left';
  const stopPropagation = (event) => {
    event.stopPropagation();
  };
  return (
    <div
      className={`canvas-stack-port-rail ${side}`}
      style={{ top: `${top}px` }}
    >
      <span
        aria-hidden="true"
        className={`canvas-stack-port-glyph outer ${isLeft ? 'outer-in' : 'outer-out'}`}
        style={stackPortGlyphStyle(side, 'outer')}
      />
      <Handle
        id={isLeft ? `target-stack-outer-in-${pairIndex}` : `source-stack-outer-out-${pairIndex}`}
        type={isLeft ? 'target' : 'source'}
        position={isLeft ? Position.Left : Position.Right}
        className={`canvas-handle illustration canvas-stack-port-handle outer ${isLeft ? 'outer-in' : 'outer-out'}`}
        style={stackPortHandleStyle(side, 'outer')}
        isConnectable={graphEditable}
        isConnectableStart={!isLeft && graphEditable}
        isConnectableEnd={isLeft && graphEditable}
        onMouseDown={stopPropagation}
        onClick={stopPropagation}
      />
      <span
        aria-hidden="true"
        className={`canvas-stack-port-glyph inner ${isLeft ? 'inner-out' : 'inner-in'}`}
        style={stackPortGlyphStyle(side, 'inner')}
      />
      <Handle
        id={isLeft ? `source-stack-inner-out-${pairIndex}` : `target-stack-inner-in-${pairIndex}`}
        type={isLeft ? 'source' : 'target'}
        position={isLeft ? Position.Right : Position.Left}
        className={`canvas-handle illustration canvas-stack-port-handle inner ${isLeft ? 'inner-out' : 'inner-in'}`}
        style={stackPortHandleStyle(side, 'inner')}
        isConnectable={graphEditable}
        isConnectableStart={isLeft && graphEditable}
        isConnectableEnd={!isLeft && graphEditable}
        onMouseDown={stopPropagation}
        onClick={stopPropagation}
      />
    </div>
  );
}

function stackLocalHandlePoint({ width, ioPairs, handleId }) {
  const raw = String(handleId || '');
  const match = raw.match(/-(\d+)$/);
  const pairIndex = match ? Number(match[1]) : 0;
  const y = stackPortPairY(pairIndex, ioPairs);
  if (raw.includes('target-stack-outer-in')) return { x: stackPortCenterX('left', 'outer', width), y, position: Position.Left };
  if (raw.includes('source-stack-inner-out')) return { x: stackPortCenterX('left', 'inner', width), y, position: Position.Right };
  if (raw.includes('target-stack-inner-in')) return { x: stackPortCenterX('right', 'inner', width), y, position: Position.Left };
  if (raw.includes('source-stack-outer-out')) return { x: stackPortCenterX('right', 'outer', width), y, position: Position.Right };
  return null;
}

function childLocalHandlePoint(child, handleId, fallbackPosition) {
  const raw = String(handleId || '');
  if (child?.type === 'stack') {
    const stackPoint = stackLocalHandlePoint({
      width: child.width,
      ioPairs: child.ioPairs || 1,
      handleId,
    });
    if (stackPoint) {
      return {
        x: child.x + stackPoint.x,
        y: child.y + stackPoint.y,
        position: stackPoint.position,
      };
    }
  }
  if (child?.type === 'decision') {
    const diamondCornerOffset = 138 * 0.71;
    const decisionWidth = Number(child.modelWidth || child.width || 0);
    const decisionHeight = Number(child.modelHeight || child.height || 0);
    const centerX = child.x + (decisionWidth / 2);
    const centerY = child.y + (decisionHeight / 2);
    if (raw === 'target-left' || (!raw && fallbackPosition === Position.Left)) {
      return { x: centerX - diamondCornerOffset, y: centerY, position: Position.Left };
    }
    if (raw === 'source-top') {
      return { x: centerX, y: centerY - diamondCornerOffset, position: Position.Top };
    }
    if (raw === 'source-bottom') {
      return { x: centerX, y: centerY + diamondCornerOffset, position: Position.Bottom };
    }
  }
  if (raw === 'target-left') {
    return { x: child.x, y: child.y + (child.height / 2), position: Position.Left };
  }
  if (raw === 'source-right') {
    return { x: child.x + child.width, y: child.y + (child.height / 2), position: Position.Right };
  }
  if (raw === 'source-top') {
    return { x: child.x + (child.width / 2), y: child.y, position: Position.Top };
  }
  if (raw === 'source-bottom') {
    return { x: child.x + (child.width / 2), y: child.y + child.height, position: Position.Bottom };
  }
  if (fallbackPosition === Position.Left) {
    return { x: child.x, y: child.y + (child.height / 2), position: Position.Left };
  }
  if (fallbackPosition === Position.Top) {
    return { x: child.x + (child.width / 2), y: child.y, position: Position.Top };
  }
  if (fallbackPosition === Position.Bottom) {
    return { x: child.x + (child.width / 2), y: child.y + child.height, position: Position.Bottom };
  }
  return { x: child.x + child.width, y: child.y + (child.height / 2), position: Position.Right };
}

function StackInternalEdgeOverlay({
  width,
  height,
  ioPairs,
  children = [],
  edges = [],
  selectedEdgeId = '',
  graphEditable = false,
  onSelectEdge = null,
  onEdgeContextMenu = null,
}) {
  const overlayOriginOffset = 2;
  const childById = new Map(children.map((child) => {
    const childWidth = Number(child.width || 0);
    const childHeight = Number(child.height || 0);
    const maxX = Math.max(0, Number(width || 0) - childWidth);
    const maxY = Math.max(0, Number(height || 0) - childHeight);
    const clampedX = Math.min(Math.max(Number(child.x || 0), 0), maxX);
    const clampedY = Math.min(Math.max(Number(child.y || 0), 0), maxY);
    return [child.id, {
      ...child,
      x: clampedX - overlayOriginOffset,
      y: clampedY - overlayOriginOffset,
      width: childWidth,
      height: childHeight,
      modelWidth: Number(child.modelWidth || childWidth),
      modelHeight: Number(child.modelHeight || childHeight),
    }];
  }));
  const edgeNodeById = createIllustrationNodeMap(children);
  const overlayEdges = edges.map((edge) => {
    const edgeView = createIllustrationEdgeView(edge, edgeNodeById);
    const sourceChild = childById.get(edge.source) || null;
    const targetChild = childById.get(edge.target) || null;
    const sourcePoint = sourceChild
      ? childLocalHandlePoint(sourceChild, edge.sourceHandle, Position.Right)
      : stackLocalHandlePoint({ width, ioPairs, handleId: edge.sourceHandle });
    const targetPoint = targetChild
      ? childLocalHandlePoint(targetChild, edge.targetHandle, Position.Left)
      : stackLocalHandlePoint({ width, ioPairs, handleId: edge.targetHandle });
    if (!sourcePoint || !targetPoint) return null;
    const [path] = getUnifiedEdgePath({
      sourceX: sourcePoint.x,
      sourceY: sourcePoint.y,
      targetX: targetPoint.x,
      targetY: targetPoint.y,
      sourcePosition: sourcePoint.position,
      targetPosition: targetPoint.position,
      sourceHandleId: edge.sourceHandle,
      targetHandleId: edge.targetHandle,
      route: edge.route || null,
    });
    return { id: edge.id, path, label: edgeView.branchLabel };
  }).filter(Boolean);

  if (!overlayEdges.length) return null;

  const handleOverlayPointerSelect = (event) => {
    if (!graphEditable || typeof onSelectEdge !== 'function') return;
    const svg = event.currentTarget;
    const matrix = svg.getScreenCTM?.();
    if (!matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    let best = { edgeId: '', distance: Number.POSITIVE_INFINITY };
    svg.querySelectorAll('.canvas-illustration-stack-edge-hit-path').forEach((pathNode) => {
      const total = typeof pathNode.getTotalLength === 'function' ? pathNode.getTotalLength() : 0;
      if (!total) return;
      const steps = Math.max(8, Math.ceil(total / 12));
      for (let index = 0; index <= steps; index += 1) {
        const sample = pathNode.getPointAtLength((total * index) / steps);
        const distance = Math.hypot(point.x - sample.x, point.y - sample.y);
        if (distance < best.distance) {
          best = {
            edgeId: pathNode.getAttribute('data-edge-id') || '',
            distance,
          };
        }
      }
    });
    if (!best.edgeId || best.distance > 14) return;
    event.preventDefault();
    event.stopPropagation();
    onSelectEdge(best.edgeId);
  };
  const handleEdgePointerDown = (event) => {
    if (!graphEditable || typeof onSelectEdge !== 'function') return;
    event.stopPropagation();
  };
  const handleEdgeClick = (event, edgeId) => {
    if (!graphEditable || typeof onSelectEdge !== 'function') return;
    event.preventDefault();
    event.stopPropagation();
    onSelectEdge(edgeId);
  };
  const handleEdgeContextMenu = (event, edgeId) => {
    if (!graphEditable || typeof onEdgeContextMenu !== 'function') return;
    event.preventDefault();
    event.stopPropagation();
    onEdgeContextMenu(event, edgeId);
  };

  return (
    <svg
      className="canvas-illustration-stack-edge-overlay"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      onPointerDown={handleOverlayPointerSelect}
      onClick={handleOverlayPointerSelect}
    >
      {overlayEdges.map((edge) => (
        <React.Fragment key={edge.id}>
          <path
            id={`stack-edge-path-${edge.id}`}
            data-edge-id={edge.id}
            d={edge.path}
            className={`canvas-illustration-stack-edge-overlay-path${edge.id === selectedEdgeId ? ' is-selected' : ''}`}
          />
          {graphEditable && typeof onSelectEdge === 'function' ? (
            <path
              data-edge-id={edge.id}
              d={edge.path}
              className="canvas-illustration-stack-edge-hit-path"
              onPointerDown={handleEdgePointerDown}
              onClick={(event) => handleEdgeClick(event, edge.id)}
              onContextMenu={(event) => handleEdgeContextMenu(event, edge.id)}
            />
          ) : null}
          {edge.label ? (
            <>
              {graphEditable && typeof onSelectEdge === 'function' ? (
                <text
                  data-edge-id={edge.id}
                  className="canvas-illustration-stack-edge-label-hit"
                  dy="-5"
                  onPointerDown={handleEdgePointerDown}
                  onClick={(event) => handleEdgeClick(event, edge.id)}
                  onContextMenu={(event) => handleEdgeContextMenu(event, edge.id)}
                >
                  <textPath href={`#stack-edge-path-${edge.id}`} startOffset="22%">{edge.label}</textPath>
                </text>
              ) : null}
              <text
                data-edge-id={edge.id}
                className={`canvas-illustration-stack-edge-label${graphEditable && typeof onSelectEdge === 'function' ? ' is-clickable' : ''}`}
                dy="-5"
                onPointerDown={handleEdgePointerDown}
                onClick={(event) => handleEdgeClick(event, edge.id)}
                onContextMenu={(event) => handleEdgeContextMenu(event, edge.id)}
              >
                <textPath href={`#stack-edge-path-${edge.id}`} startOffset="22%">{edge.label}</textPath>
              </text>
            </>
          ) : null}
        </React.Fragment>
      ))}
    </svg>
  );
}

function IllustrationTypeIcon({ type }) {
  const Icon = {
    process: Play,
    decision: GitBranch,
    artifact: FileText,
    stack: Workflow,
    callout: MessageSquareQuote,
    label: Tag,
    group: Box,
    lane: Box,
    note: MessageSquareQuote,
  }[type] || Box;
  return (
    <span className="canvas-illustration-icon-badge" aria-hidden="true">
      <Icon size={16} strokeWidth={2.2} />
    </span>
  );
}

function IllustrationNode({ data }) {
  const colorMeta = illustrationColorMeta(data.color);
  const nodeMeta = ILLUSTRATION_NODE_TYPE_META[data.illustrationType] || ILLUSTRATION_NODE_TYPE_META.note;
  const fallbackText = {
    stack: 'Stack / repeated block',
    label: 'Flow label',
    lane: 'Lane / phase',
    process: 'Process step',
    decision: 'Decision / gate',
    artifact: 'Artifact / output',
    callout: 'Context note',
  }[data.illustrationType] || 'Illustration note';
  const displayText = data.text || fallbackText;
  const lines = displayText.split('\n').filter(Boolean);
  const primaryLine = lines[0] || fallbackText;
  const secondaryText = lines.slice(1).join('\n');
  const stackPairs = Math.max(1, Math.min(6, Number(data.ioPairs || 1)));
  const stackLoopCount = Math.max(1, Math.min(24, Number(data.loopCount || 1)));
  const stackHandleTop = (index, count) => {
    return stackPortPairY(index, count);
  };
  return (
    <div
      className={`canvas-illustration-node type-${data.illustrationType}${data.isSelected ? ' is-selected' : ''}`}
      style={{
        '--illustration-accent': colorMeta.accent,
        width: `${data.width || nodeMeta.width}px`,
        minHeight: `${data.height || nodeMeta.height}px`,
      }}
    >
      {data.illustrationType !== 'stack' ? (
        <Handle
          id="target-left"
          type="target"
          position={Position.Left}
          className={`canvas-handle illustration${data.illustrationType === 'decision' ? ' decision-input' : ''}${data.containerId ? ' contained' : ''}`}
          isConnectable={data.graphEditable}
          isConnectableStart={false}
          isConnectableEnd={data.graphEditable}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        />
      ) : null}
      {data.illustrationType === 'decision' ? (
        <>
          <Handle
            id="source-top"
            type="source"
            position={Position.Top}
            className="canvas-handle illustration branch branch-top"
            isConnectable={data.graphEditable}
            isConnectableStart={data.graphEditable}
            isConnectableEnd={false}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          />
          <Handle
            id="source-bottom"
            type="source"
            position={Position.Bottom}
            className="canvas-handle illustration branch branch-bottom"
            isConnectable={data.graphEditable}
            isConnectableStart={data.graphEditable}
            isConnectableEnd={false}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          />
        </>
      ) : null}
      {data.illustrationType === 'stack' ? (
        <>
          {Array.from({ length: stackPairs }).map((_, index) => (
            <StackPortRail
              key={`stack-left-${index}`}
              side="left"
              top={stackHandleTop(index, stackPairs)}
              pairIndex={index}
              graphEditable={data.graphEditable}
            />
          ))}
          {Array.from({ length: stackPairs }).map((_, index) => (
            <StackPortRail
              key={`stack-right-${index}`}
              side="right"
              top={stackHandleTop(index, stackPairs)}
              pairIndex={index}
              graphEditable={data.graphEditable}
            />
          ))}
        </>
      ) : null}
      <div className={`canvas-illustration-surface type-${data.illustrationType}`}>
        {data.illustrationType === 'label' ? (
          <div className="canvas-illustration-label-text">{displayText}</div>
        ) : data.illustrationType === 'stack' ? (
          <>
            <StackInternalEdgeOverlay
              width={data.width || nodeMeta.width}
              height={data.height || nodeMeta.height}
              ioPairs={stackPairs}
              children={data.stackChildren || []}
              edges={data.stackInternalEdges || []}
              selectedEdgeId={data.selectedEdgeId || ''}
              graphEditable={data.graphEditable}
              onSelectEdge={data.onSelectEdge}
              onEdgeContextMenu={data.onEdgeContextMenu}
            />
            <div className="canvas-illustration-stack-header canvas-illustration-stack-drag-handle">
              <span className="canvas-illustration-stack-title">{primaryLine}</span>
              <span className="canvas-illustration-stack-count">{data.childCount || 0} items · ×{stackLoopCount}</span>
            </div>
            <div className="canvas-illustration-stack-body">
              {secondaryText ? (
                <div className="canvas-illustration-stack-description">{secondaryText}</div>
              ) : (
                <div className="canvas-illustration-stack-placeholder">Drop steps here. Internal cards can connect through this stack.</div>
              )}
            </div>
          </>
        ) : data.illustrationType === 'lane' || data.illustrationType === 'group' ? (
          <>
            <div className="canvas-illustration-lane-header">
              <span className="canvas-illustration-lane-title">{primaryLine}</span>
            </div>
            {secondaryText ? <div className="canvas-illustration-lane-body">{secondaryText}</div> : null}
          </>
        ) : data.illustrationType === 'decision' ? (
          <>
            <div className="canvas-illustration-decision-shape" aria-hidden="true" />
            <div className="canvas-illustration-decision-content">
              <div className="canvas-illustration-kicker centered">{nodeMeta.label}</div>
              <div className="canvas-illustration-text centered">{displayText}</div>
            </div>
          </>
        ) : data.illustrationType === 'artifact' ? (
          <>
            <IllustrationTypeIcon type={data.illustrationType} />
            <div className="canvas-illustration-kicker">{nodeMeta.label}</div>
            <div className="canvas-illustration-title">{primaryLine}</div>
            {secondaryText ? <div className="canvas-illustration-text">{secondaryText}</div> : null}
          </>
        ) : (
          <>
            {data.illustrationType === 'process' || data.illustrationType === 'callout' || data.illustrationType === 'note' ? (
              <IllustrationTypeIcon type={data.illustrationType} />
            ) : null}
            <div className="canvas-illustration-kicker">{nodeMeta.label}</div>
            {data.illustrationType === 'process' ? <div className="canvas-illustration-title">{primaryLine}</div> : null}
            <div className="canvas-illustration-text">
              {data.illustrationType === 'process' && secondaryText ? secondaryText : data.illustrationType === 'process' ? primaryLine : displayText}
            </div>
          </>
        )}
      </div>
      {data.illustrationType === 'stack' && data.graphEditable ? (
        <button
          type="button"
          className="canvas-illustration-stack-resize-grip nodrag nopan"
          aria-label="Resize stack"
          onMouseDown={(event) => data.onResizePointerDown?.(event, data.nodeId)}
        />
      ) : null}
      {data.illustrationType !== 'decision' && data.illustrationType !== 'stack' ? (
        <Handle
          id="source-right"
          type="source"
          position={Position.Right}
          className={`canvas-handle illustration${data.illustrationType === 'stack' ? ' stack-shell' : ''}${data.containerId ? ' contained' : ''}`}
          isConnectable={data.graphEditable}
          isConnectableStart={data.graphEditable}
          isConnectableEnd={false}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        />
      ) : null}
    </div>
  );
}

export const nodeTypes = {
  illustrationNode: IllustrationNode,
}

function getUnifiedEdgePath({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition = Position.Right,
  targetPosition = Position.Left,
  sourceHandleId = '',
  targetHandleId = '',
}) {
  const sourceHandle = String(sourceHandleId || '');
  const targetHandle = String(targetHandleId || '');
  const resolveStackHandlePosition = (handle, fallback) => {
    if (handle.includes('target-stack-outer-in')) return Position.Left;
    if (handle.includes('source-stack-outer-out')) return Position.Right;
    if (handle.includes('source-stack-inner-out')) return Position.Right;
    if (handle.includes('target-stack-inner-in')) return Position.Left;
    return fallback;
  };
  const resolvedSourcePosition = resolveStackHandlePosition(sourceHandle, sourcePosition);
  const resolvedTargetPosition = resolveStackHandlePosition(targetHandle, targetPosition);
  return getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition: resolvedSourcePosition,
    targetPosition: resolvedTargetPosition,
    borderRadius: 22,
    offset: sourceHandle.includes('stack-inner') || targetHandle.includes('stack-inner') ? 12 : 24,
  });
}

export function CanvasConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
  connectionLineStyle,
}) {
  const [path] = getUnifiedEdgePath({
    sourceX: fromX,
    sourceY: fromY,
    targetX: toX,
    targetY: toY,
    sourcePosition: fromPosition || Position.Right,
    targetPosition: toPosition || Position.Left,
  });

  return (
    <>
      <path
        d={path}
        fill="none"
        stroke="rgba(24, 27, 32, 0.92)"
        strokeWidth="2.5"
        strokeLinecap="round"
        style={connectionLineStyle}
      />
      <circle
        cx={toX}
        cy={toY}
        r="4"
        fill="rgba(24, 27, 32, 0.92)"
      />
    </>
  );
}

export function CanvasSmoothEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourceHandleId,
  targetHandleId,
  sourcePosition,
  targetPosition,
  style,
  markerStart,
  markerEnd,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  interactionWidth,
  data,
}) {
  const [path, labelX, labelY] = getUnifiedEdgePath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourceHandleId,
    targetHandleId,
    sourcePosition,
    targetPosition,
  });

  return (
    <BaseEdge
      id={id}
      path={path}
      labelX={labelX}
      labelY={labelY}
      label={label}
      labelStyle={labelStyle}
      labelShowBg={labelShowBg}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
      style={style}
      markerStart={markerStart}
      markerEnd={markerEnd}
      interactionWidth={interactionWidth}
    />
  );
}

function SegmentedEdgeMenu({
  items,
  anchor,
  title,
  onSelect,
  onCancel,
}) {
  const centerX = Number.isFinite(anchor?.x) ? anchor.x : 180;
  const centerY = Number.isFinite(anchor?.y) ? anchor.y : 180;
  return (
    <div className="canvas-edge-wheel-layer" onClick={onCancel}>
      <div
        className="canvas-edge-chip-menu"
        style={{ left: `${centerX}px`, top: `${centerY}px` }}
        title={title}
        onClick={(event) => event.stopPropagation()}
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`canvas-edge-chip tone-${item.id}`}
            style={{ '--edge-color': item.color }}
            onClick={() => onSelect(item.id)}
            title={item.desc}
          >
            {item.label}
          </button>
        ))}
        <button type="button" className="canvas-edge-chip cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function EdgeTypeSelector({ sourceId, targetId, anchor, onConfirm, onCancel }) {
  return (
    <SegmentedEdgeMenu
      items={EDGE_TYPES}
      anchor={anchor}
      title={`${shortTicketId(sourceId)} -> ${shortTicketId(targetId)}`}
      onSelect={onConfirm}
      onCancel={onCancel}
    />
  );
}
export function IllustrationDetailDrawer({
  item = null,
  edgeCount = 0,
  onClose,
  onTextChange,
  onTextCommit,
  onColorChange,
  onStackIoPairsChange,
  onStackLoopCountChange,
}) {
  if (!item) return null;
  const colorMeta = illustrationColorMeta(item.color);
  const typeMeta = ILLUSTRATION_NODE_TYPE_META[item.type] || ILLUSTRATION_NODE_TYPE_META.note;
  return (
    <aside className="canvas-detail-drawer canvas-illustration-drawer">
      <div className="canvas-detail-header">
        <div>
          <div className="canvas-detail-kicker">Illustration detail</div>
          <div className="canvas-detail-title">{typeMeta.label}</div>
        </div>
        <button type="button" className="canvas-detail-close" onClick={onClose} aria-label="Close illustration detail">
          ×
        </button>
      </div>
      <div className="canvas-detail-body">
        <div className="canvas-detail-summary">
          This layer is descriptive only. Use it to explain handoffs, phases, approvals, or context without changing runtime execution.
        </div>
        <div className="canvas-detail-grid">
          <span>Type</span><strong>{typeMeta.label}</strong>
          <span>Connectors</span><strong>{edgeCount}</strong>
          <span>Color</span><strong>{colorMeta.label}</strong>
        </div>
        {item.type === 'stack' ? (
          <>
            <div className="canvas-detail-section-title">Stack routing</div>
            <div className="canvas-detail-grid">
              <span>I/O pairs</span>
              <strong>
                <input
                  type="number"
                  min="1"
                  max="6"
                  className="canvas-illustration-number-input"
                  value={item.ioPairs || 1}
                  onChange={(event) => onStackIoPairsChange?.(event.target.value)}
                  onBlur={onTextCommit}
                />
              </strong>
              <span>Loop count</span>
              <strong>
                <input
                  type="number"
                  min="1"
                  max="24"
                  className="canvas-illustration-number-input"
                  value={item.loopCount || 1}
                  onChange={(event) => onStackLoopCountChange?.(event.target.value)}
                  onBlur={onTextCommit}
                />
              </strong>
            </div>
          </>
        ) : null}
        <div className="canvas-detail-section-title">Visible text</div>
        <textarea
          className="canvas-child-textarea canvas-illustration-textarea"
          value={item.text || ''}
          onChange={(event) => onTextChange(event.target.value)}
          onBlur={onTextCommit}
          rows={6}
          placeholder="Explain the phase, gate, or handoff in clear language."
        />
        <div className="canvas-detail-section-title">Accent</div>
        <div className="canvas-illustration-colors">
          {ILLUSTRATION_COLOR_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`canvas-illustration-color-swatch${item.color === option.id ? ' is-active' : ''}`}
              style={{ '--illustration-accent': option.accent }}
              onClick={() => onColorChange(option.id)}
              title={option.label}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}

function firstLine(text = '') {
  return String(text || '').split('\n')[0]?.trim() || '';
}

export function IllustrationEdgeDetailDrawer({
  edge = null,
  onClose,
  onDelete,
}) {
  if (!edge) return null;
  const label = edge.displayLabel || 'Unlabeled connector';
  const sourceLabel = firstLine(edge.sourceLabel) || edge.source || 'Source';
  const targetLabel = firstLine(edge.targetLabel) || edge.target || 'Target';
  return (
    <aside className="canvas-detail-drawer canvas-illustration-drawer">
      <div className="canvas-detail-header">
        <div>
          <div className="canvas-detail-kicker">Connector detail</div>
          <div className="canvas-detail-title">{label}</div>
        </div>
        <button type="button" className="canvas-detail-close" onClick={onClose} aria-label="Close connector detail">
          ×
        </button>
      </div>
      <div className="canvas-detail-body">
        <div className="canvas-detail-summary">
          Illustration connectors are descriptive arrows. Select a connector to inspect or remove it without changing runtime ticket state.
        </div>
        <div className="canvas-detail-grid">
          <span>From</span><strong>{sourceLabel}</strong>
          <span>To</span><strong>{targetLabel}</strong>
          <span>Scope</span><strong>{edge.isInternal ? 'Inside stack' : 'Board level'}</strong>
          <span>Branch</span><strong>{edge.branchLabel || '—'}</strong>
        </div>
        <div className="canvas-detail-actions">
          <button
            type="button"
            className="canvas-edge-confirm destructive"
            onClick={onDelete}
          >
            Delete connector
          </button>
        </div>
      </div>
    </aside>
  );
}
