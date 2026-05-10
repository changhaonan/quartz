import fs from "fs"
import path from "path"
import { visit } from "unist-util-visit"
import type { Code, Html, Root } from "mdast"
import { QuartzTransformerPlugin } from "../types"
import { getWidgetSchema, listWidgetTypes } from "../../widgets/schemas"

export interface WidgetOptions {
  failOnInvalid?: boolean
}

const defaultOpts: WidgetOptions = {
  failOnInvalid: false,
}

type WidgetAttrs = {
  type?: string
  src?: string
  path?: string
  mode?: string
  version?: string
  height?: string
  workspaceId?: string
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function parseAttrs(raw: string): WidgetAttrs {
  const attrs: WidgetAttrs = {}
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/)
    if (!match) continue
    const key = match[1] as keyof WidgetAttrs
    const value = match[2].replace(/^['"]|['"]$/g, "")
    attrs[key] = value
  }
  return attrs
}

function normalizeHeight(value: string | undefined): string | null {
  if (!value) return null
  if (/^\d+$/.test(value)) return `${value}px`
  if (/^\d+(px|vh|rem|em|%)$/.test(value)) return value
  return null
}

function renderPlaceholder(
  attrs: WidgetAttrs,
  resolvedPath: string,
  errorMessage?: string,
): string {
  if (errorMessage) {
    return `<div class="quartz-widget__error">${escapeHtml(errorMessage)}</div>`
  }
  const type = attrs.type!
  const src = attrs.src!
  const mode = attrs.mode === "live" ? "live" : "readonly"
  const version = attrs.version ?? ""
  const heightAttr = normalizeHeight(attrs.height)
  const styleAttr = heightAttr ? ` style="min-height:${escapeHtml(heightAttr)}"` : ""
  const versionAttr = version ? ` data-widget-version="${escapeHtml(version)}"` : ""
  const workspaceAttr = attrs.workspaceId
    ? ` data-workspace-id="${escapeHtml(attrs.workspaceId)}"`
    : ""

  return (
    `<div class="quartz-widget" ` +
    `data-widget-type="${escapeHtml(type)}" ` +
    `data-widget-src="${escapeHtml(src)}" ` +
    `data-widget-path="${escapeHtml(resolvedPath)}" ` +
    `data-widget-mode="${escapeHtml(mode)}"` +
    `${versionAttr}${workspaceAttr}${styleAttr}` +
    `></div>`
  )
}

function contentRelativePath(
  src: string,
  mdPath: string,
  contentRoot: string,
): string {
  if (/^https?:\/\//.test(src)) return src
  const abs = src.startsWith("/")
    ? path.resolve(contentRoot, "." + src)
    : path.resolve(path.dirname(mdPath), src)
  const rel = path.relative(contentRoot, abs)
  return rel.split(path.sep).join("/")
}

function resolveDataFile(srcAttr: string, mdPath: string): string | null {
  if (/^https?:\/\//.test(srcAttr)) return null
  const dir = path.dirname(mdPath)
  if (srcAttr.startsWith("/")) {
    return path.resolve(dir, "." + srcAttr)
  }
  return path.resolve(dir, srcAttr)
}

function validateData(
  type: string,
  src: string,
  mdPath: string,
  declaredVersion: string | undefined,
  fail: boolean,
): { ok: true } | { ok: false; message: string } {
  const descriptor = getWidgetSchema(type)
  if (!descriptor) {
    return {
      ok: false,
      message: `Unknown widget type "${type}". Known: ${listWidgetTypes().join(", ") || "(none)"}.`,
    }
  }
  if (declaredVersion && Number(declaredVersion) !== descriptor.version) {
    return {
      ok: false,
      message:
        `Widget "${type}" version mismatch in ${path.basename(mdPath)}: ` +
        `block declares v${declaredVersion}, schema is v${descriptor.version}.`,
    }
  }

  const dataFile = resolveDataFile(src, mdPath)
  if (!dataFile) return { ok: true }

  let raw: string
  try {
    raw = fs.readFileSync(dataFile, "utf8")
  } catch {
    return {
      ok: false,
      message: `Widget "${type}" in ${path.basename(mdPath)}: data file not found at ${src}`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return {
      ok: false,
      message: `Widget "${type}" in ${path.basename(mdPath)}: data file ${src} is not valid JSON: ${(e as Error).message}`,
    }
  }

  const result = descriptor.schema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ")
    const message = `Widget "${type}" in ${path.basename(mdPath)}: schema invalid for ${src} — ${issues}`
    if (fail) throw new Error(message)
    return { ok: false, message }
  }

  return { ok: true }
}

export const Widget: QuartzTransformerPlugin<Partial<WidgetOptions>> = (userOpts) => {
  const opts = { ...defaultOpts, ...userOpts } as WidgetOptions
  return {
    name: "Widget",
    markdownPlugins(ctx) {
      const contentRoot = path.resolve(ctx.argv.directory)
      return [
        () => {
          return (tree: Root, file) => {
            const mdPath = file.path ?? ""
            visit(tree, "code", (node: Code, index, parent) => {
              if (node.lang !== "widget") return
              if (!parent || index === undefined) return

              const attrs = parseAttrs(node.value ?? "")

              if (!attrs.type || !attrs.src) {
                const html: Html = {
                  type: "html",
                  value: renderPlaceholder(
                    {},
                    "",
                    "Widget block missing required `type` or `src`.",
                  ),
                }
                parent.children.splice(index, 1, html)
                return
              }

              const resolvedPath = attrs.path
                ? attrs.path
                : mdPath
                  ? contentRelativePath(attrs.src, mdPath, contentRoot)
                  : attrs.src

              if (!attrs.workspaceId) {
                const fmWorkspaceId =
                  (file.data.frontmatter as Record<string, unknown> | undefined)?.[
                    "workspaceId"
                  ]
                const runtimeWorkspaceId = file.data.runtime?.workspaceId
                const inferred =
                  typeof fmWorkspaceId === "string" && fmWorkspaceId
                    ? fmWorkspaceId
                    : runtimeWorkspaceId ?? ""
                if (inferred) attrs.workspaceId = inferred
              }

              if (mdPath) {
                const result = validateData(
                  attrs.type,
                  attrs.src,
                  mdPath,
                  attrs.version,
                  Boolean(opts.failOnInvalid),
                )
                if (!result.ok) {
                  console.warn(`[widget] ${result.message}`)
                  const html: Html = {
                    type: "html",
                    value: renderPlaceholder(attrs, resolvedPath, result.message),
                  }
                  parent.children.splice(index, 1, html)
                  return
                }
              }

              const html: Html = {
                type: "html",
                value: renderPlaceholder(attrs, resolvedPath),
              }
              parent.children.splice(index, 1, html)
            })
          }
        },
      ]
    },
  }
}
