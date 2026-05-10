import styles from "./styles/aiSidebar.scss"
// @ts-ignore
import script from "./scripts/bridge-client.inline"
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const AiSidebar: QuartzComponent = ({ fileData }: QuartzComponentProps) => {
  const frontmatter = (fileData.frontmatter ?? {}) as Record<string, string | undefined>
  const workspaceId = frontmatter.workspaceId
  const stateDir = frontmatter.stateDir
  const role = frontmatter.role ?? frontmatter.roleId
  const agent = frontmatter.agent ?? "codex"
  const cwd = frontmatter.cwd
  const model = frontmatter.model
  const difficulty = frontmatter.difficulty
  const bridgeOrigin = frontmatter.bridgeOrigin ?? "http://127.0.0.1:3210"
  const fileSlug = fileData.slug ?? "unknown"

  return (
    <aside
      class="ai-sidebar"
      data-file-slug={fileSlug}
      data-workspace-id={workspaceId ?? ""}
      data-state-dir={stateDir ?? ""}
      data-role-id={role ?? ""}
      data-agent={agent}
      data-cwd={cwd ?? ""}
      data-model={model ?? ""}
      data-difficulty={difficulty ?? ""}
      data-bridge-origin={bridgeOrigin}
    >
      <div class="ai-sidebar__header">
        <div>
          <p class="ai-sidebar__eyebrow">AI Workspace</p>
          <strong>File runtime</strong>
        </div>
        <div class="ai-sidebar__header-actions">
          <label class="ai-sidebar__client-picker">
            <span>Client</span>
            <select data-ai-client-select aria-label="AI client">
              <option value="codex" selected={agent === "codex"}>Codex</option>
              <option value="claude" selected={agent === "claude"}>Claude</option>
              <option value="kimi" selected={agent === "kimi"}>Kimi</option>
              <option value="deepseek" selected={agent === "deepseek"}>DeepSeek</option>
              <option value="coze" disabled>Coze</option>
            </select>
          </label>
          <button type="button" class="ai-sidebar__icon-button" data-ai-action="refresh" title="Refresh bridge state" aria-label="Refresh bridge state">
            ↻
          </button>
        </div>
      </div>
      <dl class="ai-sidebar__facts">
        <div>
          <dt>Workspace</dt>
          <dd data-ai-fact="workspace">{workspaceId ?? "page-scoped"}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd data-ai-fact="role">{role ?? "none"}</dd>
        </div>
        <div>
          <dt>State</dt>
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
        <a class="ai-sidebar__bridge-link" href="#" target="_blank" rel="noreferrer">Open bridge</a>
      </div>
      <section class="ai-sidebar__terminal-shell" aria-label="PTY session">
        <div class="ai-sidebar__terminal-header">
          <strong>PTY Session</strong>
          <button type="button" class="ai-sidebar__secondary-button" data-ai-action="start-pty">
            Start PTY
          </button>
        </div>
        <div class="ai-sidebar__terminal-frame" data-ai-terminal>
          <span>Start a PTY to attach an interactive Xterm session.</span>
        </div>
      </section>
      <div class="ai-sidebar__status" data-ai-status aria-live="polite">
        Ready. Messages route into the page PTY session.
      </div>
      <form class="ai-sidebar__composer" data-ai-composer>
        <textarea
          class="ai-sidebar__textarea"
          name="prompt"
          rows={5}
          placeholder="Ask about this workspace..."
        ></textarea>
        <div class="ai-sidebar__composer-actions">
          <button type="submit" class="ai-sidebar__primary-button">Send</button>
          <button type="button" class="ai-sidebar__secondary-button" data-ai-action="summarize">
            Summarize
          </button>
        </div>
      </form>
      <div class="ai-sidebar__actions" aria-label="AI sidebar actions">
        <button type="button" data-ai-action="create-file">
          Create file
        </button>
        <button type="button" data-ai-action="run-block">
          Start PTY
        </button>
        <button type="button" data-ai-action="append-run">
          Append run
        </button>
      </div>
    </aside>
  )
}

AiSidebar.css = styles
AiSidebar.afterDOMLoaded = script

export default (() => AiSidebar) satisfies QuartzComponentConstructor
