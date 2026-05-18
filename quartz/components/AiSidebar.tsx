import styles from "./styles/aiSidebar.scss"
// @ts-ignore
import script from "./scripts/bridge-client.inline"
import { AI_SIDEBAR_STRINGS } from "./scripts/aiSidebar-i18n"
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

// Default bridge origin baked in at server-render time. Priority:
//   1. page frontmatter `bridgeOrigin` (per-page override)
//   2. WORKFLOW_BRIDGE_URL env (set by scripts/run.sh per worktree)
//   3. dev fallback (3210) — only hit when running without a worktree
const SERVER_DEFAULT_BRIDGE_ORIGIN = process.env.WORKFLOW_BRIDGE_URL ?? "http://127.0.0.1:3210"
// Default agent cwd baked in at SSR. Priority:
//   1. page frontmatter `cwd`
//   2. QUARTZ_CONTENT_ROOT env (per-environment override)
//   3. process.cwd() — the quartz instance root, distinct per env (dev/staging/prod)
// This is what stops a write from prod's page landing in dev's content/.
const SERVER_DEFAULT_CWD = process.env.QUARTZ_CONTENT_ROOT ?? process.cwd()
const DEFAULT_AI_AGENT = "codex"
const DEFAULT_CODEX_MODEL = "gpt-5.4-mini"
const DEFAULT_AI_DIFFICULTY = "medium"

// No-flash i18n. The sidebar chrome is SSR'd in English, but the global
// language toggle (language.inline.ts — a beforeDOMLoaded <head> script)
// has already set <html data-lang> by the time the browser parses this
// <aside>. bridge-client.inline.ts only re-applies the locale in an
// afterDOMLoaded script — i.e. after first paint — so a zh-CN user sees
// the English chrome flash past on every hard load. This inline script
// sits immediately after the sidebar markup and runs synchronously during
// parse, swapping the [data-i18n*] strings before the browser paints.
// bridge-client still owns re-application on `langchange` / SPA `nav`.
const NO_FLASH_I18N = `(function(){
  var T = ${JSON.stringify(AI_SIDEBAR_STRINGS)};
  var s = document.currentScript;
  var root = s && s.previousElementSibling;
  if (!root || !root.classList || !root.classList.contains("ai-sidebar")) {
    root = document.querySelector(".ai-sidebar");
  }
  if (!root) return;
  var tbl = T[document.documentElement.getAttribute("data-lang")] || T["zh-CN"];
  if (!tbl) return;
  root.querySelectorAll("[data-i18n]").forEach(function(el){
    var v = tbl[el.getAttribute("data-i18n")];
    if (v != null) el.textContent = v;
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach(function(el){
    var v = tbl[el.getAttribute("data-i18n-placeholder")];
    if (v != null) el.setAttribute("placeholder", v);
  });
  root.querySelectorAll("[data-i18n-label]").forEach(function(el){
    var v = tbl[el.getAttribute("data-i18n-label")];
    if (v != null) { el.setAttribute("title", v); el.setAttribute("aria-label", v); }
  });
})();`

const AiSidebar: QuartzComponent = ({ fileData }: QuartzComponentProps) => {
  const frontmatter = (fileData.frontmatter ?? {}) as Record<string, string | undefined>
  const workspaceId = frontmatter.workspaceId
  const stateDir = frontmatter.stateDir
  const role = frontmatter.role ?? frontmatter.roleId
  const agent = frontmatter.agent ?? DEFAULT_AI_AGENT
  const cwd = frontmatter.cwd ?? SERVER_DEFAULT_CWD
  const model = frontmatter.model ?? (agent === DEFAULT_AI_AGENT ? DEFAULT_CODEX_MODEL : "")
  const difficulty = frontmatter.difficulty ?? DEFAULT_AI_DIFFICULTY
  const bridgeOrigin = frontmatter.bridgeOrigin ?? SERVER_DEFAULT_BRIDGE_ORIGIN
  const fileSlug = fileData.slug ?? "unknown"

  return (
    <>
    <aside
      class="ai-sidebar"
      data-file-slug={fileSlug}
      data-workspace-id={workspaceId ?? ""}
      data-state-dir={stateDir ?? ""}
      data-role-id={role ?? ""}
      data-agent={agent}
      data-cwd={cwd}
      data-model={model}
      data-difficulty={difficulty}
      data-bridge-origin={bridgeOrigin}
    >
      <div class="ai-sidebar__header">
        <div>
          <p class="ai-sidebar__eyebrow" data-i18n="eyebrow">
            Jarvis Workspace
          </p>
          <strong data-i18n="headerTitle">Document operator</strong>
        </div>
        <div class="ai-sidebar__header-actions">
          <label class="ai-sidebar__client-picker">
            <span data-i18n="clientLabel">Client</span>
            <select data-ai-client-select aria-label="Jarvis client">
              <option value="codex" selected={agent === "codex"}>
                Codex
              </option>
              <option value="claude" selected={agent === "claude"}>
                Claude
              </option>
              <option value="kimi" selected={agent === "kimi"}>
                Kimi
              </option>
              <option value="deepseek" selected={agent === "deepseek"}>
                DeepSeek
              </option>
              <option value="coze" disabled>
                Coze
              </option>
            </select>
          </label>
          <button
            type="button"
            class="ai-sidebar__icon-button"
            data-ai-action="refresh"
            data-i18n-label="refreshBridge"
            title="Refresh bridge state"
            aria-label="Refresh bridge state"
          >
            ↻
          </button>
        </div>
      </div>
      <dl class="ai-sidebar__facts">
        <div>
          <dt data-i18n="factWorkspace">Workspace</dt>
          <dd data-ai-fact="workspace">{workspaceId ?? "quartz-site"}</dd>
        </div>
        <div>
          <dt data-i18n="factRole">Role</dt>
          <dd data-ai-fact="role">{role ?? "none"}</dd>
        </div>
        <div>
          <dt data-i18n="factState">State</dt>
          <dd data-ai-fact="state">{stateDir ?? "not declared"}</dd>
        </div>
      </dl>
      <div class="ai-sidebar__bridge" data-bridge-status="probing">
        <div class="ai-sidebar__bridge-row">
          <span class="ai-sidebar__bridge-dot" aria-hidden="true"></span>
          <strong class="ai-sidebar__bridge-status">Bridge probing</strong>
        </div>
        <div class="ai-sidebar__bridge-meta">Looking for embedded bridge frames.</div>
        <div class="ai-sidebar__runtime-meta">Runtime manifest pending.</div>
        <a
          class="ai-sidebar__bridge-link"
          href="#"
          target="_blank"
          rel="noreferrer"
          data-i18n="openBridge"
        >
          Open bridge
        </a>
      </div>
      <section class="ai-sidebar__terminal-shell" aria-label="PTY session">
        <div class="ai-sidebar__terminal-header">
          <strong data-i18n="ptySession">PTY Session</strong>
          <button
            type="button"
            class="ai-sidebar__secondary-button"
            data-ai-action="start-pty"
            data-i18n="startPty"
          >
            Start PTY
          </button>
        </div>
        <div class="ai-sidebar__terminal-frame" data-ai-terminal>
          <span data-i18n="terminalPlaceholder">
            Start a PTY to attach an interactive Xterm session.
          </span>
        </div>
      </section>
      <div class="ai-sidebar__status" data-ai-status aria-live="polite">
        Ready. Messages route into the workspace PTY session.
      </div>
      <form class="ai-sidebar__composer" data-ai-composer>
        <textarea
          class="ai-sidebar__textarea"
          name="prompt"
          rows={5}
          placeholder="Ask about this workspace..."
          data-i18n-placeholder="composerPlaceholder"
        ></textarea>
        <div class="ai-sidebar__composer-actions">
          <button type="submit" class="ai-sidebar__primary-button" data-i18n="send">
            Send
          </button>
          <button
            type="button"
            class="ai-sidebar__secondary-button"
            data-ai-action="summarize"
            data-i18n="summarize"
          >
            Summarize
          </button>
        </div>
      </form>
      <div class="ai-sidebar__actions" aria-label="Jarvis sidebar actions">
        <button type="button" data-ai-action="ai-read" data-i18n="jarvisRead">
          Jarvis Read
        </button>
        <button type="button" data-ai-action="create-file" data-i18n="createFile">
          Create file
        </button>
        <button type="button" data-ai-action="run-block" data-i18n="startPty">
          Start PTY
        </button>
        <button type="button" data-ai-action="append-run" data-i18n="appendRun">
          Append run
        </button>
      </div>
    </aside>
    <script dangerouslySetInnerHTML={{ __html: NO_FLASH_I18N }} />
    </>
  )
}

AiSidebar.css = styles
AiSidebar.afterDOMLoaded = script

export default (() => AiSidebar) satisfies QuartzComponentConstructor
