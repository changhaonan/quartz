import styles from "./styles/aiSidebar.scss"
// @ts-ignore
import script from "./scripts/bridge-client.inline"
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
          <p class="ai-sidebar__eyebrow">AI Workspace</p>
          <strong>Document operator</strong>
        </div>
        <div class="ai-sidebar__header-actions">
          <label class="ai-sidebar__client-picker">
            <span>Client</span>
            <select data-ai-client-select aria-label="AI client">
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
            title="Refresh bridge state"
            aria-label="Refresh bridge state"
          >
            ↻
          </button>
        </div>
      </div>
      <dl class="ai-sidebar__facts">
        <div>
          <dt>Workspace</dt>
          <dd data-ai-fact="workspace">{workspaceId ?? "quartz-site"}</dd>
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
        <a class="ai-sidebar__bridge-link" href="#" target="_blank" rel="noreferrer">
          Open bridge
        </a>
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
        Ready. Messages route into the workspace PTY session.
      </div>
      <form class="ai-sidebar__composer" data-ai-composer>
        <textarea
          class="ai-sidebar__textarea"
          name="prompt"
          rows={5}
          placeholder="Ask about this workspace..."
        ></textarea>
        <div class="ai-sidebar__composer-actions">
          <button type="submit" class="ai-sidebar__primary-button">
            Send
          </button>
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
