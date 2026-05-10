// Round-trip verifier for the workflow widget's TS ↔ DAG transforms.
//
// Two directions:
//   1. TS → DAG (parser). Read a hand-authored workflow.ts, parse it,
//      then codegen back to TS, and check the regenerated TS still
//      runs and produces the same output as the original on a sample
//      binary tree.
//   2. DAG → TS (codegen). Read a hand-authored workflow.json, codegen,
//      check the produced TS runs and produces the expected output.
//
// Both directions use a small recursive treeDepth function (binary tree
// max-depth) as the test case: it has a branch (null check), two
// recursive calls, helper calls, and a return — covering most of the
// supported subset.

import { readFile, writeFile, mkdir } from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"

import { generateWorkflowSource } from "../quartz/widgets/workflow/codegen.ts"
import { parseWorkflowSource } from "../quartz/widgets/workflow/parser.ts"

const here = path.dirname(fileURLToPath(import.meta.url))
const examples = path.join(here, "workflow-examples")
const outDir = path.join(examples, "out")
if (!existsSync(outDir)) await mkdir(outDir, { recursive: true })

function banner(label) {
  console.log("\n" + "═".repeat(72))
  console.log(label)
  console.log("═".repeat(72))
}

function show(label, value) {
  console.log(`\n--- ${label} ---`)
  console.log(value)
}

function runTs(file, importExpr) {
  // Use tsx to execute a small probe that imports the workflow and runs it
  // against a fixed binary tree, printing the result.
  const probePath = path.join(outDir, "probe-runner.mjs")
  return spawnSync(
    "npx",
    ["tsx", "-e", `${importExpr}; main();`],
    { cwd: path.dirname(file), encoding: "utf8" },
  )
}

async function runWith(file, entryName) {
  const tree = {
    val: 1,
    left: { val: 2, left: { val: 4, left: null, right: null }, right: null },
    right: { val: 3, left: null, right: { val: 5, left: null, right: { val: 6, left: null, right: null } } },
  }
  const importPath = "./" + path.basename(file)
  const probe = `
import { ${entryName} } from "${importPath}"
const tree = ${JSON.stringify(tree)}
async function main() {
  const result = await ${entryName}(tree)
  process.stdout.write(JSON.stringify({ ok: true, result }))
}
main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e) }))
  process.exit(1)
})
`.trim()
  const probePath = path.join(path.dirname(file), `__probe__.mjs`)
  await writeFile(probePath, probe, "utf8")
  const result = spawnSync("npx", ["tsx", probePath], { encoding: "utf8" })
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    parsed: result.stdout ? safeJson(result.stdout) : null,
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────────────────────
// Direction 1: TS → DAG → TS, run both, compare outputs.
// ──────────────────────────────────────────────────────────────────────
banner("Direction 1 — TS → parse → JSON → codegen → TS', compare runtime output")

const originalSource = await readFile(
  path.join(examples, "treeDepth.ts"),
  "utf8",
)
show("ORIGINAL treeDepth.ts", originalSource)

const parsed = parseWorkflowSource(originalSource)
const parsedJsonPath = path.join(outDir, "treeDepth.parsed.json")
await writeFile(parsedJsonPath, JSON.stringify(parsed.data, null, 2), "utf8")
show("PARSED → treeDepth.parsed.json", JSON.stringify(parsed.data, null, 2).slice(0, 1200) + "\n... (full at " + parsedJsonPath + ")")
if (parsed.warnings.length > 0) console.warn("parser warnings:", parsed.warnings)

const regenResult = generateWorkflowSource(parsed.data, { entryName: parsed.entryName })
const regenPath = path.join(outDir, "treeDepth.regen.ts")
// Helper file is sibling of original; we re-export it from out/ so the regen
// can resolve "./treeDepthHelpers".
await writeFile(
  path.join(outDir, "treeDepthHelpers.ts"),
  await readFile(path.join(examples, "treeDepthHelpers.ts"), "utf8"),
  "utf8",
)
await writeFile(regenPath, regenResult.source, "utf8")
show("REGEN treeDepth.regen.ts", regenResult.source)
if (regenResult.warnings.length > 0) console.warn("codegen warnings:", regenResult.warnings)

const originalRun = await runWith(path.join(examples, "treeDepth.ts"), "treeDepth")
const regenRun = await runWith(regenPath, parsed.entryName)
show("ORIGINAL output", JSON.stringify(originalRun.parsed))
show("REGEN output", JSON.stringify(regenRun.parsed))

const direction1Match =
  originalRun.parsed?.ok === true &&
  regenRun.parsed?.ok === true &&
  originalRun.parsed.result === regenRun.parsed.result

console.log(`\n→ Direction 1 ${direction1Match ? "PASS ✓" : "FAIL ✗"}`)
if (!direction1Match) {
  if (originalRun.stderr) console.error("original stderr:", originalRun.stderr.slice(-1500))
  if (regenRun.stderr) console.error("regen stderr:", regenRun.stderr.slice(-1500))
}

// ──────────────────────────────────────────────────────────────────────
// Direction 2: hand-authored JSON → TS → run, compare to known answer.
// ──────────────────────────────────────────────────────────────────────
banner("Direction 2 — hand-authored JSON → codegen → TS, compare runtime output")

const handJson = JSON.parse(
  await readFile(path.join(examples, "treeDepth.json"), "utf8"),
)
const handResult = generateWorkflowSource(handJson, { entryName: "treeDepth" })
const handTsPath = path.join(outDir, "treeDepth.fromJson.ts")
await writeFile(handTsPath, handResult.source, "utf8")
show("FROM-JSON treeDepth.fromJson.ts", handResult.source)

const handRun = await runWith(handTsPath, "treeDepth")
show("FROM-JSON output", JSON.stringify(handRun.parsed))

const direction2Match =
  handRun.parsed?.ok === true &&
  originalRun.parsed?.ok === true &&
  handRun.parsed.result === originalRun.parsed.result

console.log(`\n→ Direction 2 ${direction2Match ? "PASS ✓" : "FAIL ✗"}`)
if (!direction2Match && handRun.stderr) {
  console.error("from-json stderr:", handRun.stderr.slice(-1500))
}

// ──────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────
banner("Summary")
console.log(`Direction 1 (TS → JSON → TS):    ${direction1Match ? "PASS ✓" : "FAIL ✗"}`)
console.log(`Direction 2 (hand JSON → TS):    ${direction2Match ? "PASS ✓" : "FAIL ✗"}`)
console.log(`Sample tree max-depth result:    ${originalRun.parsed?.result ?? "?"}`)

if (!direction1Match || !direction2Match) {
  process.exit(1)
}
