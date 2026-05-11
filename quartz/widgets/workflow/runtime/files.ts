// Filesystem helpers for cross-session message passing. The runtime side
// of the workflow widget runs in Node, so we use fs/promises directly. The
// workflow communicates with PTY agents through these files: agents write
// structured output, the next agent (or the workflow itself) reads it.
//
// Why files instead of PTY screen scrape: agent output gets mangled by
// terminal control codes, line wrap, and prompt formatting. Writing to a
// declared path is unambiguous, atomic, and Git-trackable.

import { promises as fs, type Stats } from "fs"
import path from "path"
import type {
  AskOptions,
  RuntimeContext,
  WaitFileOptions,
} from "./types.ts"
import { WorkflowRuntimeError } from "./types.ts"

// ─── Path resolution ──────────────────────────────────────────────────

/**
 * Resolve a workflow-declared file path against the workspace runtime root.
 *
 * Examples (workspaceId="workflows/telephone-game", contentRoot="/abs/content"):
 *   resolveOutputPath("messages/A.json", "messages")
 *     → /abs/content/workflows/telephone-game.runtime/messages/A.json
 *   resolveOutputPath("./X.json", "workspace")
 *     → /abs/content/workflows/telephone-game.runtime/X.json
 *   resolveOutputPath("/tmp/foo.json", "absolute")
 *     → /tmp/foo.json
 *   resolveOutputPath("X.json", "cwd")
 *     → process.cwd() + /X.json
 */
export function resolveOutputPath(
  outputFile: string,
  resolution: NonNullable<AskOptions["outputFileResolution"]>,
  ctx: RuntimeContext,
): string {
  if (resolution === "absolute") {
    if (!path.isAbsolute(outputFile)) {
      throw new WorkflowRuntimeError(
        `outputFile "${outputFile}" must be absolute when resolution="absolute"`,
        "bad_path",
      )
    }
    return outputFile
  }
  if (resolution === "cwd") {
    return path.isAbsolute(outputFile) ? outputFile : path.resolve(process.cwd(), outputFile)
  }
  const wsId = ctx.workspaceId
  if (!wsId) {
    throw new WorkflowRuntimeError(
      `outputFile resolution requires workspaceId; pass options.workspaceId or set runtime context`,
      "no_workspace",
    )
  }
  const runtimeDir = path.join(ctx.contentRoot, `${wsId}.runtime`)
  if (resolution === "messages") {
    // Defensive: strip a leading "messages/" so callers can use either
    // "messages/A.json" or "A.json" without a double-prefix bug.
    const cleaned = outputFile.replace(/^\.\/?/, "").replace(/^messages\//, "")
    return path.join(runtimeDir, "messages", cleaned)
  }
  // workspace: relative to <runtimeDir>
  if (path.isAbsolute(outputFile)) return outputFile
  return path.join(runtimeDir, outputFile.replace(/^\.\/?/, ""))
}

/** Convenience: where a named message file should live for the current ctx. */
export function messagePath(name: string, ctx: RuntimeContext): string {
  const safe = name.endsWith(".json") || name.endsWith(".md") || name.endsWith(".txt")
    ? name
    : `${name}.json`
  return resolveOutputPath(safe, "messages", ctx)
}

// ─── Reads / writes ───────────────────────────────────────────────────

export async function readTextFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8")
}

export async function readJsonFile<T = unknown>(filePath: string): Promise<T> {
  const text = await readTextFile(filePath)
  try {
    return JSON.parse(text) as T
  } catch (e) {
    throw new WorkflowRuntimeError(
      `not valid JSON: ${filePath} :: ${(e as Error).message}`,
      "bad_json",
      { filePath, snippet: text.slice(0, 400) },
    )
  }
}

/** Atomic write: temp file + rename. Creates parent directories. */
export async function writeAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.writeFile(tmp, content, "utf8")
    await fs.rename(tmp, filePath)
  } catch (e) {
    try {
      await fs.unlink(tmp)
    } catch {}
    throw e
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

// ─── Wait-for-file ────────────────────────────────────────────────────

interface FileSnapshot {
  exists: boolean
  size: number
  mtimeMs: number
}

async function snapshot(filePath: string): Promise<FileSnapshot> {
  try {
    const stat: Stats = await fs.stat(filePath)
    if (!stat.isFile()) return { exists: false, size: 0, mtimeMs: 0 }
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return { exists: false, size: 0, mtimeMs: 0 }
  }
}

/**
 * Wait until `filePath` exists (and optionally has been updated past
 * `mtimeFloor`). Stable-content check: we observe the file twice with a
 * `stableMs` gap and only return once both observations agree, so we don't
 * read mid-write content.
 */
export async function waitForFile(
  filePath: string,
  opts: WaitFileOptions = {},
): Promise<FileSnapshot> {
  // Tighter defaults than before: each ask() pays a fixed (intervalMs +
  // stableMs) tail at the end while we confirm the file isn't still
  // being written. 200/200 = 400ms × N hops adds up. Agent writes
  // through Codex/Claude tools are quick — 50ms is enough to catch a
  // mid-write race, and a callsite can pass a larger value when it
  // knows the writer is slow.
  const startedAt = Date.now()
  const timeoutMs = opts.timeoutMs ?? 600000
  const intervalMs = opts.intervalMs ?? 75
  const stableMs = opts.stableMs ?? 75
  const requireUpdate = opts.requireUpdate ?? false
  const mtimeFloor = opts.mtimeFloor ?? 0

  while (true) {
    if (opts.abort?.aborted) {
      throw new WorkflowRuntimeError("waitForFile aborted", "aborted", { filePath })
    }
    const snap = await snapshot(filePath)
    if (snap.exists) {
      const newEnough = !requireUpdate || snap.mtimeMs > mtimeFloor
      if (newEnough) {
        if (stableMs <= 0) return snap
        // Stable check: re-snapshot after the stable window. If size + mtime
        // unchanged, the writer is done.
        await sleep(stableMs)
        const second = await snapshot(filePath)
        if (
          second.exists &&
          second.size === snap.size &&
          second.mtimeMs === snap.mtimeMs
        ) {
          return second
        }
        // Else loop — file is still being written.
      }
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new WorkflowRuntimeError(
        `waitForFile timeout after ${timeoutMs}ms: ${filePath}`,
        "timeout",
        { filePath, lastSnapshot: snap },
      )
    }
    await sleep(intervalMs)
  }
}

// ─── Format dispatch ──────────────────────────────────────────────────

export type Format = NonNullable<AskOptions["format"]>

export function detectFormat(filePath: string, hint?: Format): Format {
  if (hint && hint !== "raw") return hint
  if (filePath.endsWith(".json")) return "json"
  if (filePath.endsWith(".md") || filePath.endsWith(".markdown")) return "markdown"
  if (filePath.endsWith(".txt")) return "text"
  return hint ?? "text"
}

export async function readByFormat<T = unknown>(
  filePath: string,
  format: Format,
): Promise<T | string> {
  const text = await readTextFile(filePath)
  if (format === "json") {
    try {
      return JSON.parse(text) as T
    } catch (e) {
      throw new WorkflowRuntimeError(
        `not valid JSON in ${filePath}: ${(e as Error).message}`,
        "bad_json",
        { filePath, snippet: text.slice(0, 400) },
      )
    }
  }
  return text
}

// ─── Tiny helpers ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
