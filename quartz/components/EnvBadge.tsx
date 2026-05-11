// Small fixed-position badge showing which env this site was built for
// (prod / staging / dev) and the short git SHA of the commit it was
// built from. Useful when prod and staging serve from the same machine
// on different ports — at a glance you know which one you're looking at.
//
// Sources, in priority order:
//   * QUARTZ_PTY_ROLE env (exported by scripts/run.sh per worktree)
//   * .quartz-pty-worktree.json `role` field at the repo root
//   * "dev" (when neither is present — interactive dev server)
//
// Version is `git rev-parse --short HEAD` captured once at module load.
// If git isn't available the version is empty and the badge collapses.

import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { QuartzComponent, QuartzComponentConstructor } from "./types"

function detectRole(): "prod" | "staging" | "dev" {
  const envRole = process.env.QUARTZ_PTY_ROLE
  if (envRole === "prod" || envRole === "staging") return envRole
  // Fallback: read the worktree config directly. Catches the case where
  // someone runs `npx quartz build --serve` without going through run.sh.
  const cfgPath = path.resolve(process.cwd(), ".quartz-pty-worktree.json")
  if (existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as { role?: string }
      if (parsed.role === "prod" || parsed.role === "staging") return parsed.role
    } catch {}
  }
  return "dev"
}

function detectVersion(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
  } catch {
    return ""
  }
}

const ROLE = detectRole()
const VERSION = detectVersion()

// Lock colors to the role so the eye associates them: prod=green (safe),
// staging=amber (caution), dev=neutral.
const ROLE_COLOR: Record<string, string> = {
  prod: "#2f9e44",
  staging: "#e8a23a",
  dev: "#7a7a7a",
}

export default (() => {
  const EnvBadge: QuartzComponent = () => {
    const color = ROLE_COLOR[ROLE] ?? ROLE_COLOR.dev
    return (
      <div class="env-badge" data-role={ROLE} style={`--env-badge-color: ${color};`}>
        <span class="env-badge-role">{ROLE.toUpperCase()}</span>
        {VERSION ? <span class="env-badge-version">{VERSION}</span> : null}
      </div>
    )
  }

  EnvBadge.css = `
    .env-badge {
      position: fixed;
      bottom: 0.75rem;
      right: 0.75rem;
      z-index: 9999;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.25rem 0.55rem;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 0.72rem;
      line-height: 1;
      color: #fff;
      background: var(--env-badge-color, #7a7a7a);
      border-radius: 4px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.18);
      pointer-events: none;
      opacity: 0.85;
    }
    .env-badge-role {
      font-weight: 600;
      letter-spacing: 0.04em;
    }
    .env-badge-version {
      opacity: 0.85;
    }
  `

  return EnvBadge
}) satisfies QuartzComponentConstructor
