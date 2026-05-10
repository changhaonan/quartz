// Shared palette presets for board widgets. Each palette entry describes a
// node type the user can add via the toolbar: visual identity (icon, accent
// color), default sizing (inherited from ILLUSTRATION_NODE_TYPE_META), and
// default content. Widgets compose their own palette from these or extend
// with widget-specific entries (e.g. workflow has llm-call, tool-call).

import {
  Box,
  FileText,
  GitBranch,
  MessageSquareQuote,
  Play,
  Tag,
  Workflow,
} from 'lucide-react'

export const ILLUSTRATION_PALETTE = [
  { type: 'note', label: 'Note', color: 'amber', Icon: MessageSquareQuote, defaultText: 'New note' },
  { type: 'process', label: 'Process', color: 'cyan', Icon: Play, defaultText: 'Process step' },
  { type: 'decision', label: 'Decision', color: 'rose', Icon: GitBranch, defaultText: 'Decision / gate' },
  { type: 'artifact', label: 'Artifact', color: 'violet', Icon: FileText, defaultText: 'Artifact / output' },
  { type: 'stack', label: 'Stack', color: 'violet', Icon: Workflow, defaultText: 'Stack\nRepeated block' },
  { type: 'lane', label: 'Lane', color: 'mint', Icon: Box, defaultText: 'Lane / phase' },
  { type: 'callout', label: 'Callout', color: 'amber', Icon: MessageSquareQuote, defaultText: 'Context note' },
  { type: 'label', label: 'Label', color: 'mint', Icon: Tag, defaultText: 'Flow label' },
]
