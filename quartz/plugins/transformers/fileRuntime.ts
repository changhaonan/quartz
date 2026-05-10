import fs from "fs"
import path from "path"
import { QuartzTransformerPlugin } from "../types"

export interface FileRuntimeArtifacts {
  board?: string
  session?: string
  blueprint?: string
  workspace?: string
}

export interface FileRuntimeMeta {
  workspaceId: string
  runtimeDir: string
  artifacts: FileRuntimeArtifacts
  hasRuns: boolean
  hasTraces: boolean
  hasEvidence: boolean
}

const ARTIFACT_FILES = ["board", "session", "blueprint", "workspace"] as const

function detectRuntime(absMarkdownPath: string, contentRoot: string): FileRuntimeMeta | null {
  const dir = path.dirname(absMarkdownPath)
  const stem = path.basename(absMarkdownPath, path.extname(absMarkdownPath))
  const runtimeDir = path.join(dir, `${stem}.runtime`)

  let stat: fs.Stats
  try {
    stat = fs.statSync(runtimeDir)
  } catch {
    return null
  }
  if (!stat.isDirectory()) return null

  const artifacts: FileRuntimeArtifacts = {}
  for (const name of ARTIFACT_FILES) {
    const fp = path.join(runtimeDir, `${name}.json`)
    if (fs.existsSync(fp)) {
      const rel = path.relative(contentRoot, fp).split(path.sep).join("/")
      artifacts[name] = rel
    }
  }

  const hasRuns = fs.existsSync(path.join(runtimeDir, "runs"))
  const hasTraces = fs.existsSync(path.join(runtimeDir, "traces"))
  const hasEvidence = fs.existsSync(path.join(runtimeDir, "evidence"))

  const workspaceId = path
    .relative(contentRoot, path.join(dir, stem))
    .split(path.sep)
    .join("/")

  return {
    workspaceId,
    runtimeDir,
    artifacts,
    hasRuns,
    hasTraces,
    hasEvidence,
  }
}

export const FileRuntime: QuartzTransformerPlugin = () => {
  return {
    name: "FileRuntime",
    markdownPlugins(ctx) {
      const contentRoot = path.resolve(ctx.argv.directory)
      return [
        () => {
          return (_tree, file) => {
            const fp = file.path
            if (!fp) return
            const meta = detectRuntime(fp, contentRoot)
            if (meta) file.data.runtime = meta
          }
        },
      ]
    },
  }
}

declare module "vfile" {
  interface DataMap {
    runtime: FileRuntimeMeta
  }
}
