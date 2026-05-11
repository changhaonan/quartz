import { promises, openSync, writeSync, closeSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { spawn as spawnChild } from "child_process"
import esbuild from "esbuild"
import { styleText } from "util"
import { sassPlugin } from "esbuild-sass-plugin"
import fs from "fs"
import { intro, outro, select, text } from "@clack/prompts"
import { rm } from "fs/promises"
import chokidar from "chokidar"
import prettyBytes from "pretty-bytes"
import { execSync, spawnSync } from "child_process"
import http from "http"
import serveHandler from "serve-handler"
import { WebSocketServer } from "ws"
import { randomUUID } from "crypto"
import { Mutex } from "async-mutex"
import { CreateArgv } from "./args.js"
import { globby } from "globby"
import {
  exitIfCancel,
  escapePath,
  gitPull,
  popContentFolder,
  stashContentFolder,
} from "./helpers.js"
import {
  UPSTREAM_NAME,
  QUARTZ_SOURCE_BRANCH,
  ORIGIN_NAME,
  version,
  fp,
  cacheFile,
  cwd,
} from "./constants.js"
import {
  composeRunDriver,
  isSafeWorkspaceId,
} from "../widgets/workflow/runtime/run-driver.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Resolve content directory path
 * @param contentPath path to resolve
 */
function resolveContentPath(contentPath) {
  if (path.isAbsolute(contentPath)) return path.relative(cwd, contentPath)
  return path.join(cwd, contentPath)
}

/**
 * Handles `npx quartz create`
 * @param {*} argv arguments for `create`
 */
export async function handleCreate(argv) {
  console.log()
  intro(styleText(["bgGreen", "black"], ` Quartz v${version} `))
  const contentFolder = resolveContentPath(argv.directory)
  let setupStrategy = argv.strategy?.toLowerCase()
  let linkResolutionStrategy = argv.links?.toLowerCase()
  const sourceDirectory = argv.source

  // If all cmd arguments were provided, check if they're valid
  if (setupStrategy && linkResolutionStrategy) {
    // If setup isn't, "new", source argument is required
    if (setupStrategy !== "new") {
      // Error handling
      if (!sourceDirectory) {
        outro(
          styleText(
            "red",
            `Setup strategies (arg '${styleText(
              "yellow",
              `-${CreateArgv.strategy.alias[0]}`,
            )}') other than '${styleText(
              "yellow",
              "new",
            )}' require content folder argument ('${styleText(
              "yellow",
              `-${CreateArgv.source.alias[0]}`,
            )}') to be set`,
          ),
        )
        process.exit(1)
      } else {
        if (!fs.existsSync(sourceDirectory)) {
          outro(
            styleText(
              "red",
              `Input directory to copy/symlink 'content' from not found ('${styleText(
                "yellow",
                sourceDirectory,
              )}', invalid argument "${styleText("yellow", `-${CreateArgv.source.alias[0]}`)})`,
            ),
          )
          process.exit(1)
        } else if (!fs.lstatSync(sourceDirectory).isDirectory()) {
          outro(
            styleText(
              "red",
              `Source directory to copy/symlink 'content' from is not a directory (found file at '${styleText(
                "yellow",
                sourceDirectory,
              )}', invalid argument ${styleText("yellow", `-${CreateArgv.source.alias[0]}`)}")`,
            ),
          )
          process.exit(1)
        }
      }
    }
  }

  // Use cli process if cmd args werent provided
  if (!setupStrategy) {
    setupStrategy = exitIfCancel(
      await select({
        message: `Choose how to initialize the content in \`${contentFolder}\``,
        options: [
          { value: "new", label: "Empty Quartz" },
          { value: "copy", label: "Copy an existing folder", hint: "overwrites `content`" },
          {
            value: "symlink",
            label: "Symlink an existing folder",
            hint: "don't select this unless you know what you are doing!",
          },
        ],
      }),
    )
  }

  async function rmContentFolder() {
    const contentStat = await fs.promises.lstat(contentFolder)
    if (contentStat.isSymbolicLink()) {
      await fs.promises.unlink(contentFolder)
    } else {
      await rm(contentFolder, { recursive: true, force: true })
    }
  }

  const gitkeepPath = path.join(contentFolder, ".gitkeep")
  if (fs.existsSync(gitkeepPath)) {
    await fs.promises.unlink(gitkeepPath)
  }
  if (setupStrategy === "copy" || setupStrategy === "symlink") {
    let originalFolder = sourceDirectory

    // If input directory was not passed, use cli
    if (!sourceDirectory) {
      originalFolder = escapePath(
        exitIfCancel(
          await text({
            message: "Enter the full path to existing content folder",
            placeholder:
              "On most terminal emulators, you can drag and drop a folder into the window and it will paste the full path",
            validate(fp) {
              const fullPath = escapePath(fp)
              if (!fs.existsSync(fullPath)) {
                return "The given path doesn't exist"
              } else if (!fs.lstatSync(fullPath).isDirectory()) {
                return "The given path is not a folder"
              }
            },
          }),
        ),
      )
    }

    await rmContentFolder()
    if (setupStrategy === "copy") {
      await fs.promises.cp(originalFolder, contentFolder, {
        recursive: true,
        preserveTimestamps: true,
      })
    } else if (setupStrategy === "symlink") {
      await fs.promises.symlink(originalFolder, contentFolder, "dir")
    }
  } else if (setupStrategy === "new") {
    await fs.promises.writeFile(
      path.join(contentFolder, "index.md"),
      `---
title: Welcome to Quartz
---

This is a blank Quartz installation.
See the [documentation](https://quartz.jzhao.xyz) for how to get started.
`,
    )
  }

  // Use cli process if cmd args werent provided
  if (!linkResolutionStrategy) {
    // get a preferred link resolution strategy
    linkResolutionStrategy = exitIfCancel(
      await select({
        message: `Choose how Quartz should resolve links in your content. This should match Obsidian's link format. You can change this later in \`quartz.config.ts\`.`,
        options: [
          {
            value: "shortest",
            label: "Treat links as shortest path",
            hint: "(default)",
          },
          {
            value: "absolute",
            label: "Treat links as absolute path",
          },
          {
            value: "relative",
            label: "Treat links as relative paths",
          },
        ],
      }),
    )
  }

  // now, do config changes
  const configFilePath = path.join(cwd, "quartz.config.ts")
  let configContent = await fs.promises.readFile(configFilePath, { encoding: "utf-8" })
  configContent = configContent.replace(
    /markdownLinkResolution: '(.+)'/,
    `markdownLinkResolution: '${linkResolutionStrategy}'`,
  )
  await fs.promises.writeFile(configFilePath, configContent)

  // setup remote
  execSync(
    `git remote show upstream || git remote add upstream https://github.com/jackyzha0/quartz.git`,
    { stdio: "ignore" },
  )

  outro(`You're all set! Not sure what to do next? Try:
  • Customizing Quartz a bit more by editing \`quartz.config.ts\`
  • Running \`npx quartz build --serve\` to preview your Quartz locally
  • Hosting your Quartz online (see: https://quartz.jzhao.xyz/hosting)
`)
}

/**
 * Handles `npx quartz build`
 * @param {*} argv arguments for `build`
 */
export async function handleBuild(argv) {
  if (argv.serve) {
    argv.watch = true
  }

  console.log(`\n${styleText(["bgGreen", "black"], ` Quartz v${version} `)} \n`)
  const ctx = await esbuild.context({
    entryPoints: [fp],
    outfile: cacheFile,
    bundle: true,
    keepNames: true,
    minifyWhitespace: true,
    minifySyntax: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    jsxImportSource: "preact",
    packages: "external",
    metafile: true,
    sourcemap: true,
    sourcesContent: false,
    plugins: [
      sassPlugin({
        type: "css-text",
        cssImports: true,
      }),
      sassPlugin({
        filter: /\.inline\.scss$/,
        type: "css",
        cssImports: true,
      }),
      {
        name: "inline-script-loader",
        setup(build) {
          build.onLoad({ filter: /\.inline\.(ts|js)$/ }, async (args) => {
            let text = await promises.readFile(args.path, "utf8")

            // remove default exports that we manually inserted
            text = text.replace("export default", "")
            text = text.replace("export", "")

            const sourcefile = path.relative(path.resolve("."), args.path)
            const resolveDir = path.dirname(sourcefile)
            const transpiled = await esbuild.build({
              stdin: {
                contents: text,
                loader: "ts",
                resolveDir,
                sourcefile,
              },
              write: false,
              bundle: true,
              minify: true,
              platform: "browser",
              format: "esm",
            })
            const rawMod = transpiled.outputFiles[0].text
            return {
              contents: rawMod,
              loader: "text",
            }
          })
        },
      },
    ],
  })

  const buildMutex = new Mutex()
  let lastBuildMs = 0
  let cleanupBuild = null
  const build = async (clientRefresh) => {
    const buildStart = new Date().getTime()
    lastBuildMs = buildStart
    const release = await buildMutex.acquire()
    if (lastBuildMs > buildStart) {
      release()
      return
    }

    if (cleanupBuild) {
      console.log(styleText("yellow", "Detected a source code change, doing a hard rebuild..."))
      await cleanupBuild()
    }

    const result = await ctx.rebuild().catch((err) => {
      console.error(`${styleText("red", "Couldn't parse Quartz configuration:")} ${fp}`)
      console.log(`Reason: ${styleText("gray", err)}`)
      process.exit(1)
    })
    release()

    if (argv.bundleInfo) {
      const outputFileName = "quartz/.quartz-cache/transpiled-build.mjs"
      const meta = result.metafile.outputs[outputFileName]
      console.log(
        `Successfully transpiled ${Object.keys(meta.inputs).length} files (${prettyBytes(
          meta.bytes,
        )})`,
      )
      console.log(await esbuild.analyzeMetafile(result.metafile, { color: true }))
    }

    // bypass module cache
    // https://github.com/nodejs/modules/issues/307
    const { default: buildQuartz } = await import(`../../${cacheFile}?update=${randomUUID()}`)
    // ^ this import is relative, so base "cacheFile" path can't be used

    cleanupBuild = await buildQuartz(argv, buildMutex, clientRefresh)
    clientRefresh()
  }

  let clientRefresh = () => {}
  if (argv.serve) {
    const connections = []
    clientRefresh = () => connections.forEach((conn) => conn.send("rebuild"))

    if (argv.baseDir !== "" && !argv.baseDir.startsWith("/")) {
      argv.baseDir = "/" + argv.baseDir
    }

    await build(clientRefresh)
    const server = http.createServer(async (req, res) => {
      // Widget write API — runs on the Quartz dev server itself so widgets
      // can mutate workspace JSON files without a separate bridge process,
      // CORS, or PTY coupling. Path is content-root-relative; atomic write
      // (temp + rename); chokidar (already watching content/) picks up the
      // change and triggers an incremental rebuild.
      const writeUrlPath = (req.url || "").split("?")[0]
      if (req.method === "POST" && writeUrlPath === `${argv.baseDir || ""}/api/widget/write`) {
        return handleWidgetWrite(req, res, argv)
      }
      if (req.method === "POST" && writeUrlPath === `${argv.baseDir || ""}/api/workflow/run`) {
        return handleWorkflowRun(req, res, argv)
      }
      if (req.method === "GET" && writeUrlPath === `${argv.baseDir || ""}/api/workflow/pending-inputs`) {
        return handleWorkflowPendingInputs(req, res, argv)
      }
      if (req.method === "POST" && writeUrlPath === `${argv.baseDir || ""}/api/workflow/input`) {
        return handleWorkflowInput(req, res, argv)
      }

      // Widget data files (workflow.json, board.json, …) live under
      // <thing>.runtime/ and are written by the widget itself via
      // /api/widget/write. The build pipeline intentionally skips these
      // paths (drag/edit fires writes constantly — rebuilding would
      // SPA-reload mid-interaction), but that means public/ never sees
      // the updates. Serve straight from content/ on every GET so the
      // widget always sees the latest state on (re)mount.
      if (
        req.method === "GET" &&
        /(^|\/)[^/]+\.runtime\/[^/]+\.json$/.test(writeUrlPath)
      ) {
        return handleRuntimeJsonGet(req, res, argv, writeUrlPath)
      }
      // Per-run log files live deeper: <ws>.runtime/runs/<runId>/{stdout,stderr}.log
      // The browser tails these during an active run to show progress.
      if (
        req.method === "GET" &&
        /(^|\/)[^/]+\.runtime\/runs\/[^/]+\/(stdout|stderr)\.log$/.test(writeUrlPath)
      ) {
        return handleRuntimeLogGet(req, res, argv, writeUrlPath)
      }
      // Active-runs index — workspace-scoped list of runs whose result.json
      // doesn't yet exist (i.e. still in flight). Browser uses this to find
      // the runId(s) to tail.
      if (req.method === "GET" && writeUrlPath === `${argv.baseDir || ""}/api/workflow/active-runs`) {
        return handleWorkflowActiveRuns(req, res, argv)
      }
      // Recent-runs index — newest-first list including completed runs,
      // with each run's status + result + exitCode + log tail. The
      // browser's auto-restore on widget mount uses this so a previous
      // run's result re-appears in the inline panel after navigate-away
      // / refresh / new tab.
      if (req.method === "GET" && writeUrlPath === `${argv.baseDir || ""}/api/workflow/runs`) {
        return handleWorkflowRuns(req, res, argv)
      }

      if (argv.baseDir && !req.url?.startsWith(argv.baseDir)) {
        console.log(
          styleText(
            "red",
            `[404] ${req.url} (warning: link outside of site, this is likely a Quartz bug)`,
          ),
        )
        res.writeHead(404)
        res.end()
        return
      }

      // strip baseDir prefix
      req.url = req.url?.slice(argv.baseDir.length)

      const serve = async () => {
        const release = await buildMutex.acquire()
        await serveHandler(req, res, {
          public: argv.output,
          directoryListing: false,
          headers: [
            {
              source: "**/*.*",
              headers: [{ key: "Content-Disposition", value: "inline" }],
            },
            {
              source: "**/*.webp",
              headers: [{ key: "Content-Type", value: "image/webp" }],
            },
            // fixes bug where avif images are displayed as text instead of images (future proof)
            {
              source: "**/*.avif",
              headers: [{ key: "Content-Type", value: "image/avif" }],
            },
          ],
        })
        const status = res.statusCode
        const statusString =
          status >= 200 && status < 300
            ? styleText("green", `[${status}]`)
            : styleText("red", `[${status}]`)
        console.log(statusString + styleText("gray", ` ${argv.baseDir}${req.url}`))
        release()
      }

      const redirect = (newFp) => {
        newFp = argv.baseDir + newFp
        res.writeHead(302, {
          Location: newFp,
        })
        console.log(
          styleText("yellow", "[302]") +
            styleText("gray", ` ${argv.baseDir}${req.url} -> ${newFp}`),
        )
        res.end()
      }

      let fp = req.url?.split("?")[0] ?? "/"

      // handle redirects
      if (fp.endsWith("/")) {
        // /trailing/
        // does /trailing/index.html exist? if so, serve it
        const indexFp = path.posix.join(fp, "index.html")
        if (fs.existsSync(path.posix.join(argv.output, indexFp))) {
          req.url = fp
          return serve()
        }

        // does /trailing.html exist? if so, redirect to /trailing
        let base = fp.slice(0, -1)
        if (path.extname(base) === "") {
          base += ".html"
        }
        if (fs.existsSync(path.posix.join(argv.output, base))) {
          return redirect(fp.slice(0, -1))
        }
      } else {
        // /regular
        // does /regular.html exist? if so, serve it
        let base = fp
        if (path.extname(base) === "") {
          base += ".html"
        }
        if (fs.existsSync(path.posix.join(argv.output, base))) {
          req.url = fp
          return serve()
        }

        // does /regular/index.html exist? if so, redirect to /regular/
        let indexFp = path.posix.join(fp, "index.html")
        if (fs.existsSync(path.posix.join(argv.output, indexFp))) {
          return redirect(fp + "/")
        }
      }

      return serve()
    })

    server.listen(argv.port)
    const wss = new WebSocketServer({ port: argv.wsPort })
    wss.on("connection", (ws) => connections.push(ws))
    console.log(
      styleText(
        "cyan",
        `Started a Quartz server listening at http://localhost:${argv.port}${argv.baseDir}`,
      ),
    )
  } else {
    await build(clientRefresh)
    ctx.dispose()
  }

  if (argv.watch) {
    const paths = await globby([
      "**/*.ts",
      "quartz/cli/*.js",
      "quartz/static/**/*",
      "**/*.tsx",
      "**/*.scss",
      "package.json",
    ])
    // Everything under any *.runtime/ folder is widget machine state
    // (data files the widget fetches at runtime, per-run logs, agent
    // message handoffs, traces, evidence). None of it is authored
    // content. Critically, the widget's own data file (workflow.json,
    // board.json) is updated on every drag-stop / edge create / etc.;
    // without this filter, every interaction inside a widget reloads
    // the entire SPA.
    const isRuntimeArtifact = (fp) => {
      if (!fp) return false
      const norm = String(fp).replace(/\\/g, "/")
      return /(^|\/)[^/]+\.runtime(\/|$)/.test(norm)
    }
    const maybeBuild = (eventPath) => {
      if (isRuntimeArtifact(eventPath)) return
      build(clientRefresh)
    }
    chokidar
      .watch(paths, { ignoreInitial: true })
      .on("add", maybeBuild)
      .on("change", maybeBuild)
      .on("unlink", maybeBuild)

    console.log(styleText("gray", "hint: exit with ctrl+c"))
  }
}

/**
 * Handles `npx quartz update`
 * @param {*} argv arguments for `update`
 */
export async function handleUpdate(argv) {
  const contentFolder = resolveContentPath(argv.directory)
  console.log(`\n${styleText(["bgGreen", "black"], ` Quartz v${version} `)} \n`)
  console.log("Backing up your content")
  execSync(
    `git remote show upstream || git remote add upstream https://github.com/jackyzha0/quartz.git`,
  )
  await stashContentFolder(contentFolder)
  console.log(
    "Pulling updates... you may need to resolve some `git` conflicts if you've made changes to components or plugins.",
  )

  try {
    gitPull(UPSTREAM_NAME, QUARTZ_SOURCE_BRANCH)
  } catch {
    console.log(styleText("red", "An error occurred above while pulling updates."))
    await popContentFolder(contentFolder)
    return
  }

  await popContentFolder(contentFolder)
  console.log("Ensuring dependencies are up to date")

  /*
  On Windows, if the command `npm` is really `npm.cmd', this call fails
  as it will be unable to find `npm`. This is often the case on systems
  where `npm` is installed via a package manager.

  This means `npx quartz update` will not actually update dependencies
  on Windows, without a manual `npm i` from the caller.

  However, by spawning a shell, we are able to call `npm.cmd`.
  See: https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows
  */

  const opts = { stdio: "inherit" }
  if (process.platform === "win32") {
    opts.shell = true
  }

  const res = spawnSync("npm", ["i"], opts)
  if (res.status === 0) {
    console.log(styleText("green", "Done!"))
  } else {
    console.log(styleText("red", "An error occurred above while installing dependencies."))
  }
}

/**
 * Handles `npx quartz restore`
 * @param {*} argv arguments for `restore`
 */
export async function handleRestore(argv) {
  const contentFolder = resolveContentPath(argv.directory)
  await popContentFolder(contentFolder)
}

/**
 * Handles `npx quartz sync`
 * @param {*} argv arguments for `sync`
 */
export async function handleSync(argv) {
  const contentFolder = resolveContentPath(argv.directory)
  console.log(`\n${styleText(["bgGreen", "black"], ` Quartz v${version} `)}\n`)
  console.log("Backing up your content")

  if (argv.commit) {
    const contentStat = await fs.promises.lstat(contentFolder)
    if (contentStat.isSymbolicLink()) {
      const linkTarg = await fs.promises.readlink(contentFolder)
      console.log(styleText("yellow", "Detected symlink, trying to dereference before committing"))

      // stash symlink file
      await stashContentFolder(contentFolder)

      // follow symlink and copy content
      await fs.promises.cp(linkTarg, contentFolder, {
        recursive: true,
        preserveTimestamps: true,
      })
    }

    const currentTimestamp = new Date().toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    })
    const commitMessage = argv.message ?? `Quartz sync: ${currentTimestamp}`
    spawnSync("git", ["add", "."], { stdio: "inherit" })
    spawnSync("git", ["commit", "-m", commitMessage], { stdio: "inherit" })

    if (contentStat.isSymbolicLink()) {
      // put symlink back
      await popContentFolder(contentFolder)
    }
  }

  await stashContentFolder(contentFolder)

  if (argv.pull) {
    console.log(
      "Pulling updates from your repository. You may need to resolve some `git` conflicts if you've made changes to components or plugins.",
    )
    try {
      gitPull(ORIGIN_NAME, QUARTZ_SOURCE_BRANCH)
    } catch {
      console.log(styleText("red", "An error occurred above while pulling updates."))
      await popContentFolder(contentFolder)
      return
    }
  }

  await popContentFolder(contentFolder)
  if (argv.push) {
    console.log("Pushing your changes")
    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD").toString().trim()
    const res = spawnSync("git", ["push", "-uf", ORIGIN_NAME, currentBranch], {
      stdio: "inherit",
    })
    if (res.status !== 0) {
      console.log(
        styleText("red", `An error occurred above while pushing to remote ${ORIGIN_NAME}.`),
      )
      return
    }
  }

  console.log(styleText("green", "Done!"))
}

// ─── Widget write API helpers ────────────────────────────────────────────
// Used by quartz/widgets/* clients to apply JSON Patch operations to
// .runtime/*.json files atomically. Lives in the Quartz dev server so the
// renderer subsystem doesn't need an external write service. For static
// builds this code is unreachable (no `--serve`), so production deploys
// are unaffected.

function decodeJsonPointer(pointer) {
  if (!pointer) return []
  if (pointer === "/") return [""]
  if (!pointer.startsWith("/")) {
    const err = new Error(`json pointer must start with /: ${pointer}`)
    err.statusCode = 400
    throw err
  }
  return pointer
    .slice(1)
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"))
}

function applyJsonPatch(doc, ops) {
  const root = { v: doc }
  for (const op of ops) {
    if (!op || typeof op !== "object" || typeof op.op !== "string" || typeof op.path !== "string") {
      const err = new Error("invalid patch op")
      err.statusCode = 400
      throw err
    }
    const segs = decodeJsonPointer(op.path)
    const last = segs.pop()
    let parent = root
    let key = "v"
    for (const seg of segs) {
      const next = parent[key]
      if (next === null || typeof next !== "object") {
        const err = new Error(`json patch path traverses non-object: ${op.path}`)
        err.statusCode = 400
        throw err
      }
      parent = next
      key = Array.isArray(parent) ? Number(seg) : seg
    }
    const target = parent[key]
    if (target === null || typeof target !== "object") {
      const err = new Error(`json patch parent is not an object/array: ${op.path}`)
      err.statusCode = 400
      throw err
    }
    const finalKey = Array.isArray(target) ? (last === "-" ? target.length : Number(last)) : last
    if (op.op === "replace") {
      if (Array.isArray(target)) {
        if (!Number.isFinite(finalKey) || finalKey < 0 || finalKey >= target.length) {
          const err = new Error(`replace index out of bounds: ${op.path}`)
          err.statusCode = 400
          throw err
        }
      } else if (!Object.prototype.hasOwnProperty.call(target, finalKey)) {
        const err = new Error(`replace target has no key: ${op.path}`)
        err.statusCode = 400
        throw err
      }
      target[finalKey] = op.value
    } else if (op.op === "add") {
      if (Array.isArray(target)) {
        if (last === "-") target.push(op.value)
        else target.splice(Number(finalKey), 0, op.value)
      } else {
        target[finalKey] = op.value
      }
    } else if (op.op === "remove") {
      if (Array.isArray(target)) target.splice(Number(finalKey), 1)
      else delete target[finalKey]
    } else {
      const err = new Error(`unsupported op: ${op.op}`)
      err.statusCode = 400
      throw err
    }
  }
  return root.v
}

function widgetSendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(payload))
}

async function handleWidgetWrite(req, res, argv) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
  } catch (e) {
    return widgetSendJson(res, 400, {
      ok: false,
      error: { code: "bad_json", message: e.message },
    })
  }

  const filePathRel = String(body.path || "").replace(/^\/+/, "")
  const patches = Array.isArray(body.patch) ? body.patch : null
  if (!filePathRel || !patches || patches.length === 0) {
    return widgetSendJson(res, 400, {
      ok: false,
      error: { code: "missing_fields", message: "path and non-empty patch are required" },
    })
  }

  const contentRoot = path.resolve(argv.directory)
  const absPath = path.resolve(contentRoot, filePathRel)
  if (absPath !== contentRoot && !absPath.startsWith(contentRoot + path.sep)) {
    return widgetSendJson(res, 400, {
      ok: false,
      error: { code: "path_outside_content", message: "path escapes content root" },
    })
  }

  const workspaceId = String(body.workspaceId || "").trim()
  if (workspaceId) {
    const expectedRuntimePrefix = path.resolve(contentRoot, `${workspaceId}.runtime`)
    if (
      absPath !== expectedRuntimePrefix &&
      !absPath.startsWith(`${expectedRuntimePrefix}${path.sep}`)
    ) {
      return widgetSendJson(res, 400, {
        ok: false,
        error: {
          code: "path_outside_workspace",
          message: `path must live under ${workspaceId}.runtime/`,
        },
      })
    }
  }

  let stat
  try {
    stat = await promises.stat(absPath)
  } catch {
    return widgetSendJson(res, 404, {
      ok: false,
      error: { code: "not_found", message: `data file not found: ${filePathRel}` },
    })
  }

  if (body.ifVersion != null && String(body.ifVersion) !== String(stat.mtimeMs)) {
    return widgetSendJson(res, 409, {
      ok: false,
      error: {
        code: "version_conflict",
        message: "data file has been modified since read",
      },
      currentVersion: String(stat.mtimeMs),
    })
  }

  let parsed
  try {
    parsed = JSON.parse(await promises.readFile(absPath, "utf8"))
  } catch (e) {
    return widgetSendJson(res, 500, {
      ok: false,
      error: { code: "parse_error", message: `existing JSON is invalid: ${e.message}` },
    })
  }

  let updated
  try {
    updated = applyJsonPatch(parsed, patches)
  } catch (e) {
    return widgetSendJson(res, e.statusCode || 400, {
      ok: false,
      error: { code: "patch_failed", message: e.message },
    })
  }

  const tmpPath = `${absPath}.${process.pid}.${Date.now()}.tmp`
  try {
    await promises.writeFile(tmpPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8")
    await promises.rename(tmpPath, absPath)
  } catch (e) {
    try {
      await promises.unlink(tmpPath)
    } catch {}
    return widgetSendJson(res, 500, {
      ok: false,
      error: { code: "write_error", message: e.message },
    })
  }

  const newStat = await promises.stat(absPath)
  return widgetSendJson(res, 200, {
    ok: true,
    newVersion: String(newStat.mtimeMs),
  })
}

// ─── Workflow run API ────────────────────────────────────────────────
// Drives execution of a workflow board. Widget posts the codegen'd
// source + workspace context, dev server writes a self-contained
// run.ts file into .runtime/runs/<timestamp>/, spawns `npx tsx` on
// it, captures stdout/stderr/result, persists artifacts, returns
// the outcome. file-as-truth: every run leaves a directory you can
// inspect afterwards (and that chokidar will rebuild the site for).

async function handleWorkflowRun(req, res, argv) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
  } catch (e) {
    return widgetSendJson(res, 400, {
      ok: false,
      error: { code: "bad_json", message: e.message },
    })
  }

  const workspaceId = String(body.workspaceId || "").trim()
  const source = String(body.source || "")
  const entryName = String(body.entryName || "workflow")
  const entryParams = Array.isArray(body.entryParams) ? body.entryParams : []

  if (!workspaceId || !isSafeWorkspaceId(workspaceId)) {
    return widgetSendJson(res, 400, {
      ok: false,
      error: { code: "bad_workspace", message: `invalid workspaceId: ${workspaceId}` },
    })
  }
  if (!source) {
    return widgetSendJson(res, 400, {
      ok: false,
      error: { code: "no_source", message: "source is required" },
    })
  }

  const contentRoot = path.resolve(argv.directory)
  const quartzRoot = path.resolve(__dirname, "..", "..")
  const runtimePath = path.join(
    quartzRoot,
    "quartz",
    "widgets",
    "workflow",
    "runtime",
    "index.ts",
  )

  // Layout per-run artifacts under .runtime/runs/<iso-timestamp>/.
  // chokidar is already watching content/, so these files trigger a
  // rebuild — sidebar / explorer can show them.
  const runId =
    new Date().toISOString().replace(/[:.]/g, "-") +
    "-" +
    Math.random().toString(36).slice(2, 7)
  const runDir = path.join(contentRoot, `${workspaceId}.runtime`, "runs", runId)
  await promises.mkdir(runDir, { recursive: true })

  const runScriptPath = path.join(runDir, "run.ts")
  const argsPath = path.join(runDir, "args.json")
  const resultPath = path.join(runDir, "result.json")
  const stdoutPath = path.join(runDir, "stdout.log")
  const stderrPath = path.join(runDir, "stderr.log")

  const driverSource = composeRunDriver({
    source,
    runtimePath,
    contentRoot,
    workspaceId,
    entryName,
    argsPath,
    resultPath,
  })

  try {
    await promises.writeFile(runScriptPath, driverSource, "utf8")
    await promises.writeFile(argsPath, JSON.stringify(entryParams, null, 2), "utf8")
  } catch (e) {
    return widgetSendJson(res, 500, {
      ok: false,
      error: { code: "write_error", message: e.message },
    })
  }

  // Spawn `node` directly. Node 25 strips TS types natively, so we don't
  // need a tsx prefix; this also avoids tsx-resolution failures when the
  // process happens to be running from a directory without local
  // node_modules. Inherit env so WORKFLOW_BRIDGE_URL and any agent
  // secrets propagate.
  const child = spawnChild(
    "node",
    [runScriptPath],
    {
      cwd: contentRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  // Stream stdout/stderr to disk as the subprocess emits them, in addition
  // to buffering in memory for the final JSON response. We use sync
  // writeSync to a held-open fd rather than fs.createWriteStream — the
  // latter holds chunks in an in-memory buffer (highWaterMark 16KB) until
  // .end() is called, so for low-volume progress lines (~1KB/run) the
  // file appears empty until the child exits. writeSync flushes each
  // chunk to the OS immediately, so a browser tailing the file sees
  // each `[hop N] sending…` line as it happens.
  const stdoutFd = openSync(stdoutPath, "w")
  const stderrFd = openSync(stderrPath, "w")
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString()
    try { writeSync(stdoutFd, chunk) } catch {}
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
    try { writeSync(stderrFd, chunk) } catch {}
  })

  // 30-minute default to comfortably cover human-in-the-loop runs that
  // pause on userInput(); short scripted workflows can pass a smaller
  // timeoutMs to bail out faster.
  const timeoutMs = Number.isFinite(body.timeoutMs)
    ? Math.max(1000, Math.min(3_600_000, body.timeoutMs))
    : 30 * 60_000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      child.kill("SIGTERM")
    } catch {}
  }, timeoutMs)

  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1))
    child.on("error", () => resolve(1))
  })
  clearTimeout(timer)

  // writeSync flushed each chunk immediately; just close the fds.
  try { closeSync(stdoutFd) } catch {}
  try { closeSync(stderrFd) } catch {}

  let result = null
  try {
    const resultText = await promises.readFile(resultPath, "utf8")
    result = JSON.parse(resultText)
  } catch {
    // result file might not exist if tsx failed before reaching __main()
  }

  // Tail the long buffers so the JSON response stays sane. The full
  // text lives in the log files on disk.
  const tail = (s, n) => (s.length > n ? s.slice(s.length - n) : s)
  return widgetSendJson(res, exitCode === 0 ? 200 : 500, {
    ok: exitCode === 0,
    runId,
    runDir: path.relative(contentRoot, runDir),
    exitCode,
    timedOut,
    stdout: tail(stdout, 16_000),
    stderr: tail(stderr, 16_000),
    result,
  })
}

// ─── Human-in-the-loop input handlers ─────────────────────────────────
// The running workflow subprocess writes
// .runtime/runs/<runId>/inputs/<reqId>.request.json when it hits a
// userInput() call. The browser polls /pending-inputs to discover those
// requests, renders a Gradio-style form, and POSTs to /input — which
// writes <reqId>.response.json so the subprocess can unblock.
//
// Path safety: we resolve everything under contentRoot/<workspaceId>.runtime
// and refuse anything that escapes (no .., no absolute paths in user input).

function inputsDirFor(argv, workspaceId, runId) {
  const contentRoot = path.resolve(argv.directory)
  const runtimeRoot = path.resolve(contentRoot, `${workspaceId}.runtime`)
  // Defense-in-depth: re-resolve and check containment after joining.
  const candidate = path.resolve(runtimeRoot, "runs", runId, "inputs")
  if (!candidate.startsWith(runtimeRoot + path.sep)) {
    return null
  }
  return candidate
}

function isSafeRunId(id) {
  if (!id) return false
  if (id.includes("..") || id.includes("/") || id.includes("\\")) return false
  return /^[A-Za-z0-9_\-:.]+$/.test(id)
}

function isSafeReqId(id) {
  if (!id) return false
  return /^[A-Za-z0-9_\-]{1,32}$/.test(id)
}

async function scanInputsDir(inputsDir, runId) {
  let entries = []
  try {
    entries = await promises.readdir(inputsDir)
  } catch (e) {
    if (e.code === "ENOENT") return []
    throw e
  }
  // A request is "pending" iff <reqId>.request.json exists with no matching
  // <reqId>.response.json. Read each request file to surface its spec to
  // the browser; ignore unparseable files (the subprocess might be
  // mid-write, in which case the browser retries next poll).
  const responseSet = new Set(
    entries
      .filter((n) => n.endsWith(".response.json"))
      .map((n) => n.slice(0, -".response.json".length)),
  )
  const pending = []
  for (const name of entries) {
    if (!name.endsWith(".request.json")) continue
    const reqId = name.slice(0, -".request.json".length)
    if (responseSet.has(reqId)) continue
    try {
      const text = await promises.readFile(path.join(inputsDir, name), "utf8")
      const parsed = JSON.parse(text)
      if (parsed?.reqId && parsed?.spec) {
        pending.push({ ...parsed, runId })
      }
    } catch {
      // Treat as not-yet-readable; keep going.
    }
  }
  return pending
}

async function handleWorkflowPendingInputs(req, res, argv) {
  const url = new URL(req.url, "http://localhost")
  const workspaceId = String(url.searchParams.get("workspaceId") || "").trim()
  const runId = String(url.searchParams.get("runId") || "").trim()

  if (!workspaceId || !isSafeWorkspaceId(workspaceId)) {
    return widgetSendJson(res, 400, {
      ok: false,
      error: { code: "bad_workspace", message: "invalid workspaceId" },
    })
  }

  const pending = []
  try {
    if (runId) {
      if (!isSafeRunId(runId)) {
        return widgetSendJson(res, 400, {
          ok: false,
          error: { code: "bad_run_id", message: "invalid runId" },
        })
      }
      const inputsDir = inputsDirFor(argv, workspaceId, runId)
      if (!inputsDir) {
        return widgetSendJson(res, 400, {
          ok: false,
          error: { code: "bad_path", message: "path escapes runtime root" },
        })
      }
      pending.push(...(await scanInputsDir(inputsDir, runId)))
    } else {
      // No runId: the browser kicked off /api/workflow/run and is waiting
      // on that response, so it doesn't know the runId yet. Scan every
      // run directory in the workspace and collect pending across all of
      // them. The browser tags its POST /api/workflow/input with the runId
      // we surface here, so it always responds to the right subprocess.
      const contentRoot = path.resolve(argv.directory)
      const runtimeRoot = path.resolve(contentRoot, `${workspaceId}.runtime`)
      const runsRoot = path.join(runtimeRoot, "runs")
      let runDirs = []
      try {
        runDirs = await promises.readdir(runsRoot)
      } catch (e) {
        if (e.code !== "ENOENT") throw e
      }
      for (const dir of runDirs) {
        if (!isSafeRunId(dir)) continue
        const inputsDir = inputsDirFor(argv, workspaceId, dir)
        if (!inputsDir) continue
        pending.push(...(await scanInputsDir(inputsDir, dir)))
      }
    }
  } catch (e) {
    return widgetSendJson(res, 500, {
      ok: false,
      error: { code: "read_error", message: e.message },
    })
  }

  // Stable ordering by requestedAt so the form list doesn't shuffle on
  // each poll. Falls back to reqId when timestamps tie.
  pending.sort((a, b) => {
    const ta = String(a.requestedAt || "")
    const tb = String(b.requestedAt || "")
    if (ta !== tb) return ta < tb ? -1 : 1
    return String(a.reqId).localeCompare(String(b.reqId))
  })
  return widgetSendJson(res, 200, { ok: true, pending })
}

async function handleWorkflowInput(req, res, argv) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
  } catch (e) {
    return widgetSendJson(res, 400, {
      ok: false,
      error: { code: "bad_json", message: e.message },
    })
  }

  const workspaceId = String(body.workspaceId || "").trim()
  const runId = String(body.runId || "").trim()
  const reqId = String(body.reqId || "").trim()
  const value = body.value

  if (!workspaceId || !isSafeWorkspaceId(workspaceId)) {
    return widgetSendJson(res, 400, {
      ok: false,
      error: { code: "bad_workspace", message: "invalid workspaceId" },
    })
  }
  if (!runId || !isSafeRunId(runId)) {
    return widgetSendJson(res, 400, {
      ok: false,
      error: { code: "bad_run_id", message: "invalid runId" },
    })
  }
  if (!reqId || !isSafeReqId(reqId)) {
    return widgetSendJson(res, 400, {
      ok: false,
      error: { code: "bad_req_id", message: "invalid reqId" },
    })
  }

  const inputsDir = inputsDirFor(argv, workspaceId, runId)
  if (!inputsDir) {
    return widgetSendJson(res, 400, {
      ok: false,
      error: { code: "bad_path", message: "path escapes runtime root" },
    })
  }

  // Sanity-check: the matching request file must exist. Without this, a
  // stray POST could plant a response.json that nothing's waiting on (the
  // subprocess writes the request first, blocks on waitForFile second).
  const requestPath = path.join(inputsDir, `${reqId}.request.json`)
  try {
    await promises.access(requestPath)
  } catch {
    return widgetSendJson(res, 404, {
      ok: false,
      error: { code: "no_request", message: `no pending request ${reqId}` },
    })
  }

  const responsePath = path.join(inputsDir, `${reqId}.response.json`)
  const payload = {
    reqId,
    value,
    respondedAt: new Date().toISOString(),
  }
  // Write atomically (temp + rename) so waitForFile's stableMs check
  // doesn't read mid-write content.
  const tmp = `${responsePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await promises.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8")
    await promises.rename(tmp, responsePath)
  } catch (e) {
    try {
      await promises.unlink(tmp)
    } catch {}
    return widgetSendJson(res, 500, {
      ok: false,
      error: { code: "write_error", message: e.message },
    })
  }
  return widgetSendJson(res, 200, { ok: true, reqId, responsePath: path.relative(path.resolve(argv.directory), responsePath) })
}

/**
 * Serve a per-run log file (stdout.log / stderr.log) live from
 * content/. Cache-control is no-store so the browser's tail loop sees
 * each new chunk written by the streamed subprocess output.
 */
async function handleRuntimeLogGet(req, res, argv, urlPath) {
  const contentRoot = path.resolve(argv.directory)
  const rel = urlPath.replace(new RegExp(`^${argv.baseDir || ""}/?`), "")
  const candidate = path.resolve(contentRoot, rel)
  if (!candidate.startsWith(contentRoot + path.sep)) {
    res.writeHead(403)
    res.end("forbidden")
    return
  }
  try {
    const buf = await promises.readFile(candidate)
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
      "pragma": "no-cache",
    })
    res.end(buf)
  } catch (e) {
    if (e.code === "ENOENT") {
      // Not-yet-created log file is normal — the subprocess may have
      // just been spawned. Return empty 200 so the client can keep
      // tailing without exception-handling 404s in a hot loop.
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      })
      res.end("")
      return
    }
    res.writeHead(500)
    res.end(String(e.message || e))
  }
}

/**
 * Workspace-scoped list of in-flight runs. A run is "active" iff its
 * directory exists but result.json doesn't (yet). Used by the browser
 * to discover the runId(s) it should tail logs for during a Run click.
 */
async function handleWorkflowActiveRuns(req, res, argv) {
  const url = new URL(req.url, "http://localhost")
  const workspaceId = String(url.searchParams.get("workspaceId") || "").trim()
  if (!workspaceId || !isSafeWorkspaceId(workspaceId)) {
    return widgetSendJson(res, 400, {
      ok: false,
      error: { code: "bad_workspace", message: "invalid workspaceId" },
    })
  }
  const contentRoot = path.resolve(argv.directory)
  const runsRoot = path.resolve(contentRoot, `${workspaceId}.runtime`, "runs")
  let entries = []
  try {
    entries = await promises.readdir(runsRoot)
  } catch (e) {
    if (e.code === "ENOENT") {
      return widgetSendJson(res, 200, { ok: true, runs: [] })
    }
    return widgetSendJson(res, 500, {
      ok: false,
      error: { code: "read_error", message: e.message },
    })
  }
  const runs = []
  for (const runId of entries) {
    if (!isSafeRunId(runId)) continue
    const runDir = path.join(runsRoot, runId)
    const resultPath = path.join(runDir, "result.json")
    let active = true
    try {
      await promises.access(resultPath)
      active = false
    } catch {}
    if (!active) continue
    // Carry stat info so the browser can sort newest-first if it cares.
    let startedAt = null
    try {
      const stat = await promises.stat(runDir)
      startedAt = stat.birthtime?.toISOString() ?? stat.mtime.toISOString()
    } catch {}
    runs.push({ runId, startedAt })
  }
  runs.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
  return widgetSendJson(res, 200, { ok: true, runs })
}

/**
 * Recent runs index — completed AND active. For each, includes whatever
 * artifacts are already on disk: result.json content (if the run
 * finished), exitCode (parsed from result.json), and the byte-size of
 * stdout.log. Used by the widget's mount-time auto-restore so a previous
 * run's result re-appears in the inline panel after navigation.
 */
async function handleWorkflowRuns(req, res, argv) {
  const url = new URL(req.url, "http://localhost")
  const workspaceId = String(url.searchParams.get("workspaceId") || "").trim()
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 10) || 10))
  if (!workspaceId || !isSafeWorkspaceId(workspaceId)) {
    return widgetSendJson(res, 400, {
      ok: false,
      error: { code: "bad_workspace", message: "invalid workspaceId" },
    })
  }
  const contentRoot = path.resolve(argv.directory)
  const runtimeRoot = path.resolve(contentRoot, `${workspaceId}.runtime`)
  const runsRoot = path.join(runtimeRoot, "runs")
  let entries = []
  try {
    entries = await promises.readdir(runsRoot)
  } catch (e) {
    if (e.code === "ENOENT") {
      return widgetSendJson(res, 200, { ok: true, runs: [] })
    }
    return widgetSendJson(res, 500, {
      ok: false,
      error: { code: "read_error", message: e.message },
    })
  }
  const candidates = entries
    .filter((id) => isSafeRunId(id))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit)

  const runs = []
  for (const runId of candidates) {
    const runDir = path.join(runsRoot, runId)
    let startedAt = null
    try {
      const stat = await promises.stat(runDir)
      startedAt = stat.birthtime?.toISOString() ?? stat.mtime.toISOString()
    } catch {}
    let result = null
    let resultMtime = null
    try {
      const text = await promises.readFile(path.join(runDir, "result.json"), "utf8")
      result = JSON.parse(text)
      const rs = await promises.stat(path.join(runDir, "result.json"))
      resultMtime = rs.mtime.toISOString()
    } catch {}
    let stdoutBytes = 0
    try {
      const s = await promises.stat(path.join(runDir, "stdout.log"))
      stdoutBytes = s.size
    } catch {}
    const status = result === null ? "running" : (result.ok ? "done" : "errored")
    runs.push({
      runId,
      startedAt,
      status,
      exitCode: result?.error ? 1 : (result?.ok ? 0 : null),
      result,
      resultMtime,
      stdoutBytes,
    })
  }
  return widgetSendJson(res, 200, { ok: true, runs })
}

/**
 * Serve a widget data file (a *.json sitting in a *.runtime/ directory)
 * directly from `content/`, bypassing the static-build cache. This is the
 * read side of the same path the widget writes to via /api/widget/write:
 * the build pipeline ignores .runtime/ changes (to avoid SPA-reloads on
 * every drag), so without this handler the served file in public/ stays
 * frozen at server-start state.
 *
 * Defense: re-resolve the path under contentRoot and reject anything that
 * escapes (no .., no absolute paths, no symlink shenanigans).
 */
async function handleRuntimeJsonGet(req, res, argv, urlPath) {
  const contentRoot = path.resolve(argv.directory)
  // urlPath is everything before "?"; strip baseDir, leading slash.
  const rel = urlPath.replace(new RegExp(`^${argv.baseDir || ""}/?`), "")
  const candidate = path.resolve(contentRoot, rel)
  if (!candidate.startsWith(contentRoot + path.sep)) {
    res.writeHead(403)
    res.end("forbidden")
    return
  }
  try {
    const buf = await promises.readFile(candidate)
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      // Disable caching aggressively — the widget already passes
      // cache: "no-cache" but a stale 200 in the browser memory cache
      // (after a back/forward nav) would defeat the whole point.
      "cache-control": "no-store, no-cache, must-revalidate",
      "pragma": "no-cache",
    })
    res.end(buf)
  } catch (e) {
    if (e.code === "ENOENT") {
      res.writeHead(404)
      res.end("not found")
      return
    }
    res.writeHead(500)
    res.end(String(e.message || e))
  }
}
