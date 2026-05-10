export function createIllustrationNodeMap(nodes = []) {
  return new Map((Array.isArray(nodes) ? nodes : []).map((node) => [node.id, node]));
}

export function getIllustrationEdgeColor(colorId = '') {
  return {
    slate: 'rgba(145, 164, 187, 0.72)',
    amber: 'rgba(242, 184, 76, 0.78)',
    mint: 'rgba(87, 196, 170, 0.76)',
    cyan: 'rgba(99, 198, 255, 0.76)',
    rose: 'rgba(239, 143, 177, 0.76)',
    violet: 'rgba(168, 144, 255, 0.76)',
  }[colorId] || 'rgba(145, 164, 187, 0.72)';
}

export function getIllustrationEdgeScope(edge, nodeById) {
  const sourceNode = nodeById?.get(edge?.source) || null;
  const targetNode = nodeById?.get(edge?.target) || null;
  const sourceContainerId = String(sourceNode?.containerId || '').trim();
  const targetContainerId = String(targetNode?.containerId || '').trim();
  const internalStackId = sourceContainerId && sourceContainerId === targetContainerId
    ? sourceContainerId
    : sourceNode?.type === 'stack' && targetContainerId === sourceNode.id
      ? sourceNode.id
      : targetNode?.type === 'stack' && sourceContainerId === targetNode.id
        ? targetNode.id
        : '';
  return {
    sourceNode,
    targetNode,
    sourceContainerId,
    targetContainerId,
    internalStackId,
    isInternal: !!internalStackId,
  };
}

export function getDecisionBranchLabel(edge, sourceNode) {
  if (sourceNode?.type !== 'decision') return '';
  const normalizedLabel = String(edge?.label || '').trim().toLowerCase();
  if (normalizedLabel === 'yes') return 'Yes';
  if (normalizedLabel === 'no') return 'No';
  if (!normalizedLabel && edge?.sourceHandle === 'source-top') return 'Yes';
  if (!normalizedLabel && edge?.sourceHandle === 'source-bottom') return 'No';
  return '';
}

export function getIllustrationEdgeDisplayLabel(edge, sourceNode) {
  const rawLabel = String(edge?.label || '').trim();
  if (rawLabel) return rawLabel;
  return getDecisionBranchLabel(edge, sourceNode);
}

export function createIllustrationEdgeView(edge, nodeById) {
  const scope = getIllustrationEdgeScope(edge, nodeById);
  const displayLabel = getIllustrationEdgeDisplayLabel(edge, scope.sourceNode);
  return {
    ...edge,
    ...scope,
    colorValue: getIllustrationEdgeColor(edge?.color),
    displayLabel,
    branchLabel: getDecisionBranchLabel(edge, scope.sourceNode),
    sourceLabel: scope.sourceNode?.text || edge?.source || '',
    targetLabel: scope.targetNode?.text || edge?.target || '',
  };
}
