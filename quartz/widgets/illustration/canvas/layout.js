// Illustration-only ELK layout port from claude_pty/client/src/blueprint/canvas/layout.js.
// Ticket-side layout (computeLayout + helpers) and dagre fallback are stripped — ELK
// is the actual code path. If ELK fails for a real graph we will re-add the fallback.

import { ILLUSTRATION_NODE_TYPE_META } from './illustration-helpers.js';
const ILLUSTRATION_LAYOUT = {
  nodeSep: 72,
  rankSep: 164,
  rootMarginX: 72,
  rootMarginY: 72,
  stackMarginX: 56,
  stackMarginTop: 104,
  stackMarginBottom: 56,
  stackMinGapRight: 56,
};

let elkInstancePromise = null;

async function getElkInstance() {
  if (!elkInstancePromise) {
    elkInstancePromise = import('elkjs/lib/elk.bundled.js').then((module) => {
      const ElkConstructor = module.default || module;
      return new ElkConstructor();
    });
  }
  return elkInstancePromise;
}

function illustrationNodeSize(node = {}) {
  const meta = ILLUSTRATION_NODE_TYPE_META[node.type] || ILLUSTRATION_NODE_TYPE_META.note;
  return {
    width: Math.max(80, Math.round(Number(node.width || meta.width || 240))),
    height: Math.max(48, Math.round(Number(node.height || meta.height || 120))),
  };
}

function buildIllustrationChildrenByContainer(nodes = []) {
  return nodes.reduce((acc, node) => {
    const containerId = String(node.containerId || '').trim();
    if (!acc.has(containerId)) acc.set(containerId, []);
    acc.get(containerId).push(node.id);
    return acc;
  }, new Map());
}

function firstLine(value = '') {
  return String(value || '').split('\n')[0] || '';
}

function sortIllustrationNodeIds(ids, nodeById) {
  return ids.slice().sort((leftId, rightId) => {
    const left = nodeById.get(leftId) || {};
    const right = nodeById.get(rightId) || {};
    return Number(left.y || 0) - Number(right.y || 0)
      || Number(left.x || 0) - Number(right.x || 0)
      || firstLine(left.text).localeCompare(firstLine(right.text))
      || leftId.localeCompare(rightId);
  });
}


function isIllustrationContainerType(type) {
  return type === 'stack' || type === 'lane' || type === 'group';
}

function buildNodeDepthMap(nodes = []) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const depthById = new Map();
  const visit = (node, seen = new Set()) => {
    if (!node || seen.has(node.id)) return 0;
    if (depthById.has(node.id)) return depthById.get(node.id);
    const containerId = String(node.containerId || '').trim();
    if (!containerId || !nodeById.has(containerId)) {
      depthById.set(node.id, 0);
      return 0;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(node.id);
    const depth = visit(nodeById.get(containerId), nextSeen) + 1;
    depthById.set(node.id, depth);
    return depth;
  };
  for (const node of nodes) visit(node);
  return depthById;
}

function buildDescendantIdMap(nodes = []) {
  const childrenByContainer = buildIllustrationChildrenByContainer(nodes);
  const collect = (id, seen = new Set()) => {
    if (seen.has(id)) return new Set();
    seen.add(id);
    const result = new Set();
    for (const childId of childrenByContainer.get(id) || []) {
      result.add(childId);
      for (const descendantId of collect(childId, seen)) result.add(descendantId);
    }
    return result;
  };
  return new Map(nodes.map((node) => [node.id, collect(node.id)]));
}

function shiftIllustrationSubtree(rootId, delta, nodeById, descendantIdsById) {
  const ids = new Set([rootId, ...(descendantIdsById.get(rootId) || [])]);
  for (const id of ids) {
    const node = nodeById.get(id);
    if (!node) continue;
    node.x = Math.round(Number(node.x || 0) + delta.x);
    node.y = Math.round(Number(node.y || 0) + delta.y);
  }
}

function normalizeElkStackBounds(nodes = []) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const childrenByContainer = buildIllustrationChildrenByContainer(nodes);
  const depthById = buildNodeDepthMap(nodes);
  const descendantIdsById = buildDescendantIdMap(nodes);
  const stacks = nodes
    .filter((node) => node.type === 'stack')
    .sort((left, right) => (depthById.get(right.id) || 0) - (depthById.get(left.id) || 0));

  for (const stack of stacks) {
    const childIds = childrenByContainer.get(stack.id) || [];
    if (!childIds.length) continue;
    const childBoxes = childIds
      .map((childId) => nodeById.get(childId))
      .filter(Boolean)
      .map((child) => {
        const size = illustrationNodeSize(child);
        return {
          id: child.id,
          minX: Number(child.x || 0),
          minY: Number(child.y || 0),
          maxX: Number(child.x || 0) + size.width,
          maxY: Number(child.y || 0) + size.height,
        };
      });
    if (!childBoxes.length) continue;
    const minChildX = Math.min(...childBoxes.map((box) => box.minX));
    const minChildY = Math.min(...childBoxes.map((box) => box.minY));
    const minAllowedX = Number(stack.x || 0) + ILLUSTRATION_LAYOUT.stackMarginX;
    const minAllowedY = Number(stack.y || 0) + ILLUSTRATION_LAYOUT.stackMarginTop;
    const delta = {
      x: Math.max(0, minAllowedX - minChildX),
      y: Math.max(0, minAllowedY - minChildY),
    };
    if (delta.x || delta.y) {
      for (const childId of childIds) shiftIllustrationSubtree(childId, delta, nodeById, descendantIdsById);
    }
    const shiftedBoxes = childIds
      .map((childId) => nodeById.get(childId))
      .filter(Boolean)
      .map((child) => {
        const size = illustrationNodeSize(child);
        return {
          maxX: Number(child.x || 0) + size.width,
          maxY: Number(child.y || 0) + size.height,
        };
      });
    const size = illustrationNodeSize(stack);
    stack.width = Math.max(
      size.width,
      Math.ceil(Math.max(...shiftedBoxes.map((box) => box.maxX)) - Number(stack.x || 0) + ILLUSTRATION_LAYOUT.stackMinGapRight),
    );
    stack.height = Math.max(
      size.height,
      Math.ceil(Math.max(...shiftedBoxes.map((box) => box.maxY)) - Number(stack.y || 0) + ILLUSTRATION_LAYOUT.stackMarginBottom),
    );
  }
}

function elkPadding({ top, right, bottom, left }) {
  return `[top=${top},left=${left},bottom=${bottom},right=${right}]`;
}

function createElkNode(node, childrenByContainer, nodeById) {
  const size = illustrationNodeSize(node);
  const childIds = sortIllustrationNodeIds(childrenByContainer.get(node.id) || [], nodeById);
  const children = isIllustrationContainerType(node.type)
    ? childIds.map((childId) => createElkNode(nodeById.get(childId), childrenByContainer, nodeById)).filter(Boolean)
    : [];
  const layoutOptions = children.length
    ? {
      'elk.padding': elkPadding({
        top: node.type === 'stack' ? ILLUSTRATION_LAYOUT.stackMarginTop : 56,
        right: ILLUSTRATION_LAYOUT.stackMinGapRight,
        bottom: ILLUSTRATION_LAYOUT.stackMarginBottom,
        left: ILLUSTRATION_LAYOUT.stackMarginX,
      }),
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '58',
      'elk.layered.spacing.nodeNodeBetweenLayers': '136',
    }
    : undefined;
  return {
    id: node.id,
    width: size.width,
    height: size.height,
    ...(layoutOptions ? { layoutOptions } : {}),
    ...(children.length ? { children } : {}),
  };
}

function edgeLooksLikeBackEdge(edge = {}) {
  const label = String(edge.label || '').toLowerCase();
  return label.includes('loop') || label.includes('return') || label.includes('again') || label.includes('auto-submit');
}

function isAncestorIllustrationNode(ancestorId, nodeId, nodeById) {
  let current = nodeById.get(nodeId) || null;
  const seen = new Set();
  while (current?.containerId) {
    const containerId = String(current.containerId || '').trim();
    if (!containerId || seen.has(containerId)) return false;
    if (containerId === ancestorId) return true;
    seen.add(containerId);
    current = nodeById.get(containerId) || null;
  }
  return false;
}

function edgeParticipatesInElkRanking(edge, nodeById) {
  const source = nodeById.get(edge.source) || null;
  const target = nodeById.get(edge.target) || null;
  if (!source || !target) return false;
  if (edgeLooksLikeBackEdge(edge)) return false;
  if (isAncestorIllustrationNode(source.id, target.id, nodeById)) return false;
  if (isAncestorIllustrationNode(target.id, source.id, nodeById)) return false;
  return String(source.containerId || '') === String(target.containerId || '');
}

function createElkGraph(nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const childrenByContainer = buildIllustrationChildrenByContainer(nodes);
  const rootIds = sortIllustrationNodeIds(childrenByContainer.get('') || [], nodeById);
  const validNodeIds = new Set(nodes.map((node) => node.id));
  const elkEdges = edges
    .filter((edge) => validNodeIds.has(edge.source) && validNodeIds.has(edge.target))
    .filter((edge) => edgeParticipatesInElkRanking(edge, nodeById))
    .map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
      layoutOptions: {
        'elk.priority': edgeLooksLikeBackEdge(edge) ? '1' : '4',
      },
    }));

  return {
    id: 'illustration-root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': String(ILLUSTRATION_LAYOUT.nodeSep),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(ILLUSTRATION_LAYOUT.rankSep),
      'elk.spacing.edgeNode': '42',
      'elk.spacing.edgeEdge': '26',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.cycleBreaking.strategy': 'GREEDY',
      'elk.separateConnectedComponents': 'true',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.padding': elkPadding({
        top: ILLUSTRATION_LAYOUT.rootMarginY,
        right: ILLUSTRATION_LAYOUT.rootMarginX,
        bottom: ILLUSTRATION_LAYOUT.rootMarginY,
        left: ILLUSTRATION_LAYOUT.rootMarginX,
      }),
    },
    children: rootIds.map((id) => createElkNode(nodeById.get(id), childrenByContainer, nodeById)).filter(Boolean),
    edges: elkEdges,
  };
}

function applyElkPositions(elkNode, modelById, origin = { x: 0, y: 0 }) {
  for (const child of elkNode?.children || []) {
    const model = modelById.get(child.id);
    if (!model) continue;
    model.x = Math.round(origin.x + Number(child.x || 0));
    model.y = Math.round(origin.y + Number(child.y || 0));
    if (Number.isFinite(child.width)) model.width = Math.max(80, Math.round(child.width));
    if (Number.isFinite(child.height)) model.height = Math.max(48, Math.round(child.height));
    applyElkPositions(child, modelById, { x: model.x, y: model.y });
  }
}

function shiftIllustrationNodesIntoPositiveSpace(nodes = []) {
  if (!nodes.length) return;
  const minX = Math.min(...nodes.map((node) => Number(node.x || 0)));
  const minY = Math.min(...nodes.map((node) => Number(node.y || 0)));
  const shiftX = minX < ILLUSTRATION_LAYOUT.rootMarginX ? ILLUSTRATION_LAYOUT.rootMarginX - minX : 0;
  const shiftY = minY < ILLUSTRATION_LAYOUT.rootMarginY ? ILLUSTRATION_LAYOUT.rootMarginY - minY : 0;
  if (!shiftX && !shiftY) return;
  for (const node of nodes) {
    node.x = Math.round(Number(node.x || 0) + shiftX);
    node.y = Math.round(Number(node.y || 0) + shiftY);
  }
}

export async function computeIllustrationSmartLayout(illustration, options = {}) {
  const nodes = Array.isArray(illustration?.nodes) ? illustration.nodes.map((node) => ({ ...node })) : [];
  const edges = Array.isArray(illustration?.edges) ? illustration.edges.map((edge) => ({ ...edge })) : [];
  if (!nodes.length) return { nodes, edges };

  try {
    const elkInstance = await getElkInstance();
    const graph = createElkGraph(nodes, edges);
    const result = await elkInstance.layout(graph, {
      layoutOptions: options.elkLayoutOptions || {},
    });
    const modelById = new Map(nodes.map((node) => [node.id, node]));
    applyElkPositions(result, modelById);
    shiftIllustrationNodesIntoPositiveSpace(nodes);
    normalizeElkStackBounds(nodes);
    return {
      nodes: nodes.map((node) => {
        const size = illustrationNodeSize(node);
        return {
          ...node,
          width: size.width,
          height: size.height,
        };
      }),
      edges,
    };
  } catch (error) {
    if (options.throwOnLayoutError) throw error;
    // Dagre fallback dropped to avoid pulling in @dagrejs/dagre purely as a
    // backstop. Return the input unchanged so the user keeps their layout
    // and can retry; the renderer surfaces the failure as an error toast.
    console.warn('[illustration] ELK layout failed, keeping current positions', error);
    return { nodes, edges };
  }
}
