export const ILLUSTRATION_NODE_TYPE_META = {
  stack: {
    id: 'stack',
    label: 'Stack',
    description: 'Container for repeated blocks or nested steps that move together.',
    width: 320,
    height: 232,
  },
  process: {
    id: 'process',
    label: 'Process',
    description: 'Main execution step or transform block in a workflow.',
    width: 260,
    height: 132,
  },
  decision: {
    id: 'decision',
    label: 'Decision',
    description: 'Branching gate, approval, or conditional checkpoint.',
    width: 232,
    height: 232,
  },
  artifact: {
    id: 'artifact',
    label: 'Artifact',
    description: 'Data object, memory, tensor, or produced output.',
    width: 266,
    height: 138,
  },
  lane: {
    id: 'lane',
    label: 'Lane',
    description: 'Large swimlane or phase container with a visible title band.',
    width: 380,
    height: 260,
  },
  callout: {
    id: 'callout',
    label: 'Callout',
    description: 'Readable side explanation for interpretation, caveats, or hints.',
    width: 270,
    height: 150,
  },
  note: {
    id: 'note',
    label: 'Note',
    description: 'Readable annotation card for handoff, intent, or decision notes.',
    width: 260,
    height: 144,
  },
  label: {
    id: 'label',
    label: 'Label',
    description: 'Short inline label for stage names or flow markers.',
    width: 220,
    height: 84,
  },
  group: {
    id: 'group',
    label: 'Group',
    description: 'Large framed region for lanes, phases, or ownership zones.',
    width: 360,
    height: 240,
  },
};

export const ILLUSTRATION_COLOR_OPTIONS = [
  { id: 'slate', label: 'Slate', accent: '#91a4bb' },
  { id: 'amber', label: 'Amber', accent: '#f2b84c' },
  { id: 'mint', label: 'Mint', accent: '#57c4aa' },
  { id: 'cyan', label: 'Cyan', accent: '#63c6ff' },
  { id: 'rose', label: 'Rose', accent: '#ef8fb1' },
  { id: 'violet', label: 'Violet', accent: '#a890ff' },
];

function sanitizeNode(node, index = 0) {
  if (!node || typeof node !== 'object') return null;
  const type = ILLUSTRATION_NODE_TYPE_META[node.type] ? node.type : 'note';
  const meta = ILLUSTRATION_NODE_TYPE_META[type];
  const x = Number(node.x);
  const y = Number(node.y);
  const width = Number(node.width);
  const height = Number(node.height);
  return {
    id: String(node.id || `illustration-node-${index + 1}`).trim(),
    type,
    containerId: String(node.containerId || '').trim(),
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    width: Number.isFinite(width) ? Math.max(80, Math.round(width)) : meta.width,
    height: Number.isFinite(height) ? Math.max(48, Math.round(height)) : meta.height,
    text: String(node.text || '').trim(),
    color: ILLUSTRATION_COLOR_OPTIONS.some((option) => option.id === node.color) ? node.color : 'slate',
    ioPairs: type === 'stack'
      ? Math.max(1, Math.min(6, Math.round(Number(node.ioPairs || 1))))
      : 1,
    loopCount: type === 'stack'
      ? Math.max(1, Math.min(24, Math.round(Number(node.loopCount || 1))))
      : 1,
  };
}

function sanitizeEdge(edge, index = 0) {
  if (!edge || typeof edge !== 'object') return null;
  const source = String(edge.source || '').trim();
  const target = String(edge.target || '').trim();
  if (!source || !target || source === target) return null;
  const sourceHandle = String(edge.sourceHandle || '').trim();
  const targetHandle = String(edge.targetHandle || '').trim();
  const route = edge.route && typeof edge.route === 'object'
    ? {
      x: Number(edge.route.x),
      y: Number(edge.route.y),
    }
    : null;
  return {
    id: String(edge.id || `illustration-edge-${index + 1}`).trim(),
    type: 'arrow',
    source,
    target,
    sourceHandle,
    targetHandle,
    label: String(edge.label || '').trim(),
    color: ILLUSTRATION_COLOR_OPTIONS.some((option) => option.id === edge.color) ? edge.color : 'slate',
    route: route && Number.isFinite(route.x) && Number.isFinite(route.y)
      ? { x: Math.round(route.x), y: Math.round(route.y) }
      : null,
  };
}

function clampStackHandleIndex(handleId, node) {
  const raw = String(handleId || '').trim();
  if (!raw || !node || node.type !== 'stack' || !raw.includes('stack-')) return raw;
  const match = raw.match(/^(.*-)(\d+)$/);
  if (!match) return raw;
  const count = Math.max(1, Math.min(6, Math.round(Number(node.ioPairs || 1))));
  const clampedIndex = Math.max(0, Math.min(count - 1, Number(match[2] || 0)));
  return `${match[1]}${clampedIndex}`;
}

export function normalizeIllustrationData(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes.map((node, index) => sanitizeNode(node, index)).filter(Boolean)
    : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = Array.isArray(raw.edges)
    ? raw.edges
      .map((edge, index) => sanitizeEdge(edge, index))
      .filter((edge) => {
        if (!edge) return false;
        if (edge.source.startsWith('illustration-node-') && !nodeIds.has(edge.source)) return false;
        if (edge.target.startsWith('illustration-node-') && !nodeIds.has(edge.target)) return false;
        return true;
      })
      .map((edge) => {
        const sourceNode = nodeIds.has(edge.source) ? nodes.find((node) => node.id === edge.source) || null : null;
        const targetNode = nodeIds.has(edge.target) ? nodes.find((node) => node.id === edge.target) || null : null;
        return {
          ...edge,
          sourceHandle: clampStackHandleIndex(edge.sourceHandle, sourceNode),
          targetHandle: clampStackHandleIndex(edge.targetHandle, targetNode),
        };
      })
    : [];
  return { nodes, edges };
}

export function createIllustrationNode(type, position, index = 0) {
  const meta = ILLUSTRATION_NODE_TYPE_META[type] || ILLUSTRATION_NODE_TYPE_META.note;
  const defaults = {
    stack: { text: 'Stack\nRepeated N times', color: 'violet' },
    process: { text: 'Process step', color: 'cyan' },
    decision: { text: 'Decision / approval gate', color: 'rose' },
    artifact: { text: 'Artifact / representation', color: 'violet' },
    lane: { text: 'Lane / phase', color: 'mint' },
    callout: { text: 'Context, constraint, or reading note.', color: 'amber' },
    group: { text: 'Phase / lane', color: 'cyan' },
    label: { text: 'Flow label', color: 'mint' },
    note: { text: 'Describe intent, gate, or handoff here.', color: 'amber' },
  }[meta.id] || { text: 'Illustration note', color: 'slate' };
  return {
    id: `illustration-node-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    type: meta.id,
    containerId: '',
    x: Math.round(Number(position?.x || 0)),
    y: Math.round(Number(position?.y || 0)),
    width: meta.width,
    height: meta.height,
    text: defaults.text,
    color: defaults.color,
    ioPairs: meta.id === 'stack' ? 1 : 1,
    loopCount: meta.id === 'stack' ? 1 : 1,
  };
}

export function createIllustrationEdge(connectionOrSource, maybeTarget) {
  const connection = typeof connectionOrSource === 'object' && connectionOrSource !== null
    ? connectionOrSource
    : { source: connectionOrSource, target: maybeTarget };
  const sourceHandle = String(connection.sourceHandle || '').trim();
  const label = sourceHandle === 'source-top'
    ? 'Yes'
    : sourceHandle === 'source-bottom'
      ? 'No'
      : '';
  return {
    id: `illustration-edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'arrow',
    source: String(connection.source || '').trim(),
    target: String(connection.target || '').trim(),
    sourceHandle,
    targetHandle: String(connection.targetHandle || '').trim(),
    label,
    color: 'slate',
    route: null,
  };
}

export function illustrationColorMeta(colorId) {
  return ILLUSTRATION_COLOR_OPTIONS.find((option) => option.id === colorId) || ILLUSTRATION_COLOR_OPTIONS[0];
}
