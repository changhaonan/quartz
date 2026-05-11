// Composes a self-contained, tsx-runnable .ts file from a generated
// workflow source. The file is dropped into .runtime/runs/<ts>/run.ts and
// invoked via `npx tsx run.ts`. It:
//
//   1. Imports the runtime via an absolute path (so the file location can be
//      anywhere — we don't depend on relative-path arithmetic that would
//      break under .runtime/runs/<ts>/).
//   2. Calls setRuntimeContext({ contentRoot, workspaceId }) so file-based
//      message handoff resolves the same way it would from the browser side.
//   3. Splices in the codegen source body. Top-level imports are reshaped:
//        - runtime imports (paths that point at quartz/widgets/workflow/
//          runtime) are dropped — we destructure runtime locally.
//        - relative imports (`./tools`, `../helpers`) get rewritten to
//          absolute paths against the workspace's runtime directory, so
//          users can drop a `tools.ts` next to their workflow.json and have
//          it resolve from .runtime/runs/<ts>/.
//        - bare module imports (`zod`, `lodash`) are left alone — Node
//          resolves them from the project's node_modules normally.
//   4. Reads entry args from a JSON arg-file (avoids quoting hell in
//      process.env), calls the entry function, writes
//      { ok, result } | { ok: false, error } to a result-file the parent
//      reads back.
//
// Pure string composition — no I/O, no subprocess. The HTTP endpoint that
// drives this owns the spawn, the file writes, and the result wait. Keeping
// the composer pure makes it easy to unit test.

import path from "node:path"
import { existsSync } from "node:fs"

export interface RunDriverInputs {
  /** Generated workflow source (from codegen.ts). */
  source: string
  /** Absolute path to quartz/widgets/workflow/runtime/index.ts. */
  runtimePath: string
  /** Absolute path to the content root (Quartz's argv.directory). */
  contentRoot: string
  /** Workspace id, e.g. "workflows/telephone-game". */
  workspaceId: string
  /** Function name to invoke. Default "workflow". */
  entryName?: string
  /** Absolute path the args JSON lives at. Driver reads this and parses. */
  argsPath: string
  /** Absolute path the driver writes its outcome JSON to. */
  resultPath: string
}

/**
 * Strips top-level `import ... from "..."` statements from a source string.
 * Used by the older "strip everything" path; the smarter rewriter
 * `reshapeImports` is what composeRunDriver actually calls.
 */
export function stripImports(source: string): string {
  return source.replace(
    /^[ \t]*import\b[\s\S]*?from\s+["'][^"']+["'][ \t]*;?[ \t]*\r?\n/gm,
    "",
  )
}

/**
 * Rewrites the codegen output's imports for execution under
 * `.runtime/runs/<ts>/run.ts`:
 *
 *   - Runtime imports (path contains `quartz/widgets/workflow/runtime`)
 *     are dropped. The driver destructures the runtime locally.
 *   - Relative imports (`./X`, `../Y`) are rewritten to absolute paths
 *     against the workspace's runtime root, so the user can put a
 *     `tools.ts` next to their `workflow.json` and have it found from
 *     the deeper run directory.
 *   - Bare specifiers (`zod`, `node:fs`) are kept as-is — Node resolves
 *     them against the project's node_modules / built-ins.
 *
 * The replacement is whitespace-preserving where possible; one newline
 * is appended to keep line counts roughly aligned with the input (matters
 * for the stack traces we capture in result.json).
 */
export function reshapeImports(source: string, workspaceRuntimeDir: string): string {
  const importRe =
    /^[ \t]*import\b([\s\S]*?)from\s+["']([^"']+)["'][ \t]*;?[ \t]*\r?\n/gm
  return source.replace(importRe, (match, names: string, specifier: string) => {
    // Drop our runtime imports — destructure handles them locally.
    if (/quartz\/widgets\/workflow\/runtime/.test(specifier)) {
      return ""
    }
    // Relative path: resolve against the workspace's .runtime directory.
    // Codegen produces things like `import { llm } from "./tools"`; the
    // user's intent is "alongside the workflow.json file", which is the
    // .runtime directory itself. Node ESM requires an explicit file
    // extension on relative imports, so probe the common variants
    // (`.ts`, `.js`, `/index.ts`, `/index.js`) and pin the first hit.
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const base = path.resolve(workspaceRuntimeDir, specifier)
      const candidates = [
        base,
        `${base}.ts`,
        `${base}.js`,
        `${base}.mjs`,
        path.join(base, "index.ts"),
        path.join(base, "index.js"),
        path.join(base, "index.mjs"),
      ]
      const resolved = candidates.find((p) => existsSync(p))
      const target = resolved ?? `${base}.ts` // leave the .ts to surface a clear ENOENT
      return `import${names}from ${JSON.stringify(target)}\n`
    }
    // Bare module specifier or absolute path — leave alone.
    return match
  })
}

/**
 * Build the driver script. Returns the full TS source as a string ready to
 * write to .runtime/runs/<ts>/run.ts.
 */
export function composeRunDriver(inputs: RunDriverInputs): string {
  const entryName = inputs.entryName ?? "workflow"
  const workspaceRuntimeDir = path.resolve(
    inputs.contentRoot,
    `${inputs.workspaceId}.runtime`,
  )
  const body = reshapeImports(inputs.source, workspaceRuntimeDir)

  // The destructure pulls in the surface the codegen output expects (ask /
  // spawn / input / etc.). We destructure from `__rt` so we don't shadow
  // anything the body defines locally (the body might `const ask = ...` in
  // the future — unlikely but cheap to guard against).
  //
  // runDir is the directory we're writing into right now (parent of the run
  // script). Passing it via setRuntimeContext lets userInput() drop its
  // request files alongside run.ts / result.json so the browser can find
  // them with just the runId.
  const runDir = path.dirname(inputs.resultPath)
  return `// AUTO-GENERATED by quartz workflow run-driver. DO NOT EDIT.
import * as __rt from ${JSON.stringify(inputs.runtimePath)}
import { readFile as __readFile, writeFile as __writeFile } from "node:fs/promises"
import { writeSync as __writeSync } from "node:fs"

// Node's process.stdout.write to a piped parent is async-buffered —
// console.log lines accumulate in libuv's stdio buffer and only flush
// when the buffer fills (~16KB) or process.exit forces a drain. For
// low-volume progress logs that means the browser-side tail sees
// nothing until the run finishes. Replace console.log/console.error
// with writeSync against fd 1/2: that goes straight to the OS without
// JS-side buffering, so each line appears in stdout.log within ms of
// being emitted.
const __origLog = console.log
const __origErr = console.error
const __format = (args) =>
  args
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a)))
    .join(" ") + "\\n"
console.log = (...args) => {
  try { __writeSync(1, __format(args)) } catch { __origLog(...args) }
}
console.error = (...args) => {
  try { __writeSync(2, __format(args)) } catch { __origErr(...args) }
}

const {
  ask,
  spawn,
  input,
  submit,
  interrupt,
  read,
  waitFor,
  waitForState,
  userInput,
  fileTicket,
  completeTicket,
  cancelTicket,
  releaseAllOpenTickets,
  messagePath,
  setRuntimeContext,
  setDefaultBridge,
  waitForFile,
  writeAtomic,
  writeJsonAtomic,
  readTextFile,
  readJsonFile,
} = __rt

setRuntimeContext({
  contentRoot: ${JSON.stringify(inputs.contentRoot)},
  workspaceId: ${JSON.stringify(inputs.workspaceId)},
  runDir: ${JSON.stringify(runDir)},
})

${body}

async function __main() {
  let __args: unknown[] = []
  try {
    const __argsText = await __readFile(${JSON.stringify(inputs.argsPath)}, "utf8")
    const __parsed = JSON.parse(__argsText)
    __args = Array.isArray(__parsed) ? __parsed : [__parsed]
  } catch (e) {
    console.error("[run-driver] could not read args file:", (e as Error).message)
  }
  let __exitCode = 0
  try {
    // @ts-ignore — ${entryName} is declared in the spliced body.
    const __result = await ${entryName}(...__args)
    await __writeFile(
      ${JSON.stringify(inputs.resultPath)},
      JSON.stringify({ ok: true, result: __result }, null, 2),
      "utf8",
    )
    console.log("__RUN_OK__")
  } catch (e) {
    __exitCode = 1
    const __err = e as Error
    const __payload = {
      ok: false,
      error: {
        message: __err.message,
        name: __err.name,
        code: (__err as Error & { code?: string }).code,
        stack: __err.stack,
      },
    }
    await __writeFile(
      ${JSON.stringify(inputs.resultPath)},
      JSON.stringify(__payload, null, 2),
      "utf8",
    )
    console.error("__RUN_ERR__")
    console.error(__err.stack ?? __err.message)
  } finally {
    // Sweep any tickets the workflow filed. Best-effort: errors are
    // already logged inside releaseAllOpenTickets and don't override the
    // workflow's own exit code.
    try {
      await releaseAllOpenTickets()
    } catch (e) {
      console.error("[run-driver] ticket cleanup raised:", (e as Error).message)
    }
  }
  process.exit(__exitCode)
}

void __main()
`
}

/**
 * Validate a workspaceId is safe to use in a filesystem path. Rejects
 * absolute paths, parent traversal, and anything that isn't a "normal"
 * workspace identifier. The caller's own path joining is the real defense;
 * this is a sanity check.
 */
export function isSafeWorkspaceId(id: string): boolean {
  if (!id) return false
  if (id.startsWith("/") || id.startsWith("\\")) return false
  if (id.includes("..")) return false
  // Reject control chars and whitespace explicitly. Hex form keeps the
  // source-file bytes pure ASCII; an earlier paste-corruption put a real
  // NUL into the regex, which made git mark this file binary.
  if (/[\x00-\x1f\s]/.test(id)) return false
  return /^[A-Za-z0-9_\-./]+$/.test(id)
}
