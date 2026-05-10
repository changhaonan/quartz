export const EDGE_TYPES = [
  { id: 'spawn', label: 'Child', color: '#6e80ff', desc: 'Draft a parent/child work relationship' },
  { id: 'redirect', label: 'Prerequisite', color: '#ffb347', desc: 'Draft that the target depends on the source first' },
];

export const CHILD_DIFFICULTY_OPTIONS = [
  { id: 'easy', label: 'Easy', hint: 'DeepSeek / Kimi' },
  { id: 'medium', label: 'Medium', hint: 'Codex' },
  { id: 'hard', label: 'Hard', hint: 'Claude' },
];

export const NODE_WIDTH = 292;
export const NODE_BASE_HEIGHT = 110;
export const DETAIL_LINE_HEIGHT = 24;
export const H_GAP = 44;
export const ROOT_GAP = 92;

export const MINIMAP_NODE_COLORS = {
  working: '#4ec9b0',
  idle: '#6e80ff',
  'no-owner': '#ffb347',
  unrouted: '#ff6b6b',
  done: '#8b949e',
  cancelled: '#8b949e',
  'stuck-low': '#ffb347',
  'stuck-mid': '#ff8c00',
  'stuck-high': '#ff4500',
};
