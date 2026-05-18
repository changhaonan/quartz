// i18n string table for the AI sidebar. The active locale is the GLOBAL one
// (<html data-lang>, set by language.inline.ts). bridge-client.inline.ts
// applies it to [data-i18n*] elements on load and on the `langchange` event.
//
// The AI sidebar is SSR'd in English (build-time cfg.locale), so the English
// table doubles as the no-JS fallback. zh-CN is the swap-in.

export type SidebarLang = "zh-CN" | "en-US"
export type SidebarStrings = Record<string, string>

const zhCN: SidebarStrings = {
  // header
  eyebrow: "Jarvis 工作区",
  headerTitle: "文档操作员",
  clientLabel: "客户端",
  refreshBridge: "刷新 bridge 状态",
  // facts
  factWorkspace: "工作区",
  factRole: "角色",
  factState: "状态目录",
  // bridge
  openBridge: "打开 bridge",
  // terminal
  ptySession: "PTY 会话",
  startPty: "启动 PTY",
  terminalPlaceholder: "启动 PTY 接入交互式 Xterm 会话。",
  // composer
  composerPlaceholder: "询问关于这个工作区的问题…",
  send: "发送",
  summarize: "总结",
  // actions
  jarvisRead: "Jarvis 阅读",
  createFile: "新建文件",
  appendRun: "追加运行",
}

const enUS: SidebarStrings = {
  eyebrow: "Jarvis Workspace",
  headerTitle: "Document operator",
  clientLabel: "Client",
  refreshBridge: "Refresh bridge state",
  factWorkspace: "Workspace",
  factRole: "Role",
  factState: "State",
  openBridge: "Open bridge",
  ptySession: "PTY Session",
  startPty: "Start PTY",
  terminalPlaceholder: "Start a PTY to attach an interactive Xterm session.",
  composerPlaceholder: "Ask about this workspace...",
  send: "Send",
  summarize: "Summarize",
  jarvisRead: "Jarvis Read",
  createFile: "Create file",
  appendRun: "Append run",
}

export const AI_SIDEBAR_STRINGS: Record<SidebarLang, SidebarStrings> = {
  "zh-CN": zhCN,
  "en-US": enUS,
}

// Resolve a locale string to its table; unknown locales fall back to zh-CN.
export function aiSidebarStrings(lang: string | null): SidebarStrings {
  return AI_SIDEBAR_STRINGS[lang as SidebarLang] ?? zhCN
}
