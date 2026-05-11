# Workflow Runtime API

The surface a workflow (or an agent composing a workflow) can call. All
exports live under `quartz/widgets/workflow/runtime/` and are imported
via the runtime index:

```ts
import {
  ask, spawn, userInput,
  fileTicket, completeTicket, cancelTicket, releaseAllOpenTickets,
  input, submit, interrupt, read, waitFor, waitForState,
  messagePath, resolveOutputPath,
  waitForFile, readTextFile, readJsonFile, writeAtomic, writeJsonAtomic,
  detectFormat, readByFormat,
  setRuntimeContext, getRuntimeContext, setDefaultBridge, resolveBridge,
  WorkflowRuntimeError,
} from "../../../quartz/widgets/workflow/runtime/index.ts"
```

The five sections below match the conceptual layers. Each entry has a
one-paragraph description, the signature, and the smallest call that
makes sense. Runnable examples (full workflow.json + tools.ts) live
under `content/workflows/example-*`.

---

## 1. Lifecycle — agents and tickets

The bridge owns session lifecycle. The workflow runtime is a client:
file a ticket to get a session bound for the run, talk to it, close the
ticket when finished. The run-driver's `finally` block calls
`releaseAllOpenTickets()` automatically, so a workflow that throws still
cleans up.

### `fileTicket(spec)` → `TicketHandle`

File a bridge ticket and wait until a session is routed to it. Returns
`{ ticketId, sessionId, bridge }`. The ticket gets registered on the
runtime context so the run-driver can sweep it on exit; you can also
close it yourself with `completeTicket(handle)` if you want explicit
control over when the session goes away.

The body sent to the agent contains a directive telling it to treat
each subsequent message on the session as a task and not auto-close.
That lets you talk to the session multiple times during the run.

```ts
const t = await fileTicket({
  role: "generalist",            // bridge role id; see GET /api/roles
  summary: "telephone-game relay",
  body: "Echo every JSON payload unchanged.",
  awaitDeliveryMs: 30_000,        // optional; default 30s
})
// t.sessionId is now usable for ask()
```

### `completeTicket(handle, opts?)`

Close a ticket. From the workflow runtime (admin caller) this goes
through bridge's `closed_by_operator` path, which requires an
`operatorNote` — the function supplies a canonical one if you don't.

```ts
await completeTicket(t, { operatorNote: "research-loop run done" })
```

### `cancelTicket(handle, opts?)`

Error-path close. Same sweep behaviour as complete on the bridge side,
but semantically distinct in the ticket trace.

```ts
await cancelTicket(t, { reason: "workflow timed out" })
```

### `releaseAllOpenTickets()`

Best-effort cleanup of every ticket filed during this run. The
run-driver's `finally` block calls this; you usually don't need to
invoke it yourself.

### `spawn(spec)` → `SpawnResult & { firstReply? }`

Direct session creation via `POST /api/sessions`. Bypasses the ticket
queue — useful when you want a throwaway session for a one-off task
or when you need a specific `agent`/`model`/`cwd` combo. The session
is *not* auto-cleaned by the runtime; close it explicitly when done.

```ts
const r = await spawn({ agent: "codex", role: "generalist" })
// r.sessionId
```

---

## 2. Talking to a session

### `ask(target, prompt, opts?)` → `AskResult`

The workhorse. Sends a prompt, waits for the session to settle back to
`waiting_input`, returns the reply. Two completion modes:

* **File mode** (set `outputFile`): the runtime appends an `[OUTPUT
  INSTRUCTION]` line telling the agent where to write its result, then
  waits for the file to appear and parses it by `format`. Most reliable
  for any agent that has Write tools.
* **PTY-extract mode** (default fallback): wait for the session to
  leave `thinking`/`tool_running`, then extract `reply` from `facts.lastOutput`
  (or the function you pass via `extract`).

Optional `context` is rendered as a `[CONTEXT]` JSON code block in the
prompt — convenient for passing the previous step's output without
quoting JSON into a string by hand.

```ts
const r = await ask(t.sessionId, "Summarize this page in one sentence.", {
  context: page,
  outputFile: "summary.md",
  outputFileResolution: "messages",
  format: "markdown",
})
// r.reply is the parsed file content
// r.state is the final session state
// r.durationMs is how long the round trip took
```

### `input(sessionId, data, opts?)`, `submit(sessionId)`, `interrupt(sessionId)`

Low-level send primitives when `ask` is overkill — e.g. you want to
script an interactive flow (send `y`, then `n`, then wait for a
specific output). `interrupt` sends Ctrl-C; bridge's `/interrupt`
endpoint if available, otherwise an empty-string input as a fallback.

```ts
await input(sid, "y", { submit: true })
await interrupt(sid)
```

### `read(sessionId)` → `SessionState`

Read the session's current state + facts (`lastInput`, `lastOutput`,
screen, etc.). Cheap; useful as a check before deciding what to do
next.

### `waitFor(sessionId, predicate, opts?)`, `waitForState(sessionId, expected, opts?)`

Poll-based waits. `waitForState` is shorthand for
`waitFor(sid, s => s.state === expected)`. Both accept `timeoutMs`
(default 600s) and `intervalMs` (default 500ms).

```ts
await waitForState(sid, "waiting_input", { timeoutMs: 10_000 })
```

---

## 3. Human-in-the-loop

### `userInput(spec)` → `string | number | boolean`

Pause the workflow, drop a request file under `runs/<id>/inputs/`, and
wait for a response. The browser's workflow Run panel polls
`/api/workflow/pending-inputs` and renders a Gradio-style form for any
pending request; submitting POSTs the value back, the runtime unblocks,
returns the coerced value. Times out after `spec.timeoutMs` (default
10 min).

```ts
const url = await userInput({
  inputType: "text",          // text | number | select | boolean
  label: "URL to research",
  default: "https://example.com/",
  help: "Will be fetched and summarized.",
})
```

For `select`, pass `options: string[]`. For `boolean`, the form renders
a checkbox. Numbers return JS `number`, booleans return `boolean`,
text/select return `string`.

---

## 4. File-based message handoff

The runtime treats agent output as a *file write* whenever possible —
terminal control codes and prompt formatting make PTY-scraped strings
fragile, while a declared file is unambiguous, atomic, and easy to
inspect after the fact. These helpers are the foundation under `ask`'s
file mode, but you can also use them standalone (e.g. two non-PTY
helpers in your `tools.ts` exchanging data via files).

### `messagePath(name, ctx?)` → `string`

Resolve a name into `<contentRoot>/<workspaceId>.runtime/messages/<name>.json`.
Appends `.json` if no recognized extension. The runtime context
(workspaceId, contentRoot) is read automatically.

```ts
const p = messagePath("draft-for-B")
// /Users/.../content/workflows/<ws>.runtime/messages/draft-for-B.json
```

### `resolveOutputPath(file, resolution, ctx)` → `string`

Lower-level resolver. `resolution` is one of:

* `"workspace"` — relative to `<workspaceId>.runtime/`
* `"messages"` — relative to `<workspaceId>.runtime/messages/`
* `"absolute"` — must already be absolute (asserts)
* `"cwd"` — relative to `process.cwd()`

### `waitForFile(path, opts?)` → `FileSnapshot`

Wait until a file exists with stable content. Important options:

* `timeoutMs` (default 600s)
* `requireUpdate` + `mtimeFloor` — wait for an update past a known
  mtime (used when the file already existed from a prior run)
* `stableMs` (default 200) — re-observe and require unchanged content
  before returning, so the reader never sees a partial write

```ts
await waitForFile(messagePath("from-A"), {
  timeoutMs: 30_000,
  requireUpdate: true,
  mtimeFloor: Date.now() - 1000,
})
```

### `readTextFile(p)`, `readJsonFile<T>(p)`

Reads with `WorkflowRuntimeError` on parse failure.

### `writeAtomic(p, content)`, `writeJsonAtomic(p, value)`

Temp-file + rename. Concurrent readers never see a half-written file.

### `detectFormat(path, hint?)`, `readByFormat(p, format)`

Format-aware read. Format defaults from extension (`.json` →
`"json"`, `.md` → `"markdown"`, else `"text"`).

---

## 5. Context, configuration, errors

### `setRuntimeContext(ctx)`, `getRuntimeContext()`

Set or read the process-wide runtime context (`contentRoot`,
`workspaceId`, `defaultBridge`, `runDir`, `openTickets`). The run-driver
calls `setRuntimeContext` at the top of the spliced script; tests use it
to point at a tmpdir + mock bridge.

### `setDefaultBridge(endpoint)`, `resolveBridge(ref?)`, `probeBridgeHealth()`

Bridge addressing. Default is `http://127.0.0.1:3210` unless
`WORKFLOW_BRIDGE_URL` is set or `setDefaultBridge` overrode it. Passing
a `ref` argument: `"self"` (default), `"peer"` (uses
`WORKFLOW_BRIDGE_PEER_URL`), a bare URL, or a full `BridgeEndpoint`
object (lets tests inject a mock `fetch`).

### `WorkflowRuntimeError`

All runtime errors wrap into this with a stable `code` field
(`bridge_http_404`, `timeout`, `bad_json`, `ticket_no_session`,
`session_not_ready`, `input_timeout`, …) and a `details` payload. Catch
specifically by `code` if you care; let it propagate to the run-driver
otherwise (it writes a structured error to `result.json`).

---

## Workflow graph kinds (codegen targets)

Each workflow.json node has a `kind`. Codegen renders nodes by kind:

| `kind` | Renders to |
|---|---|
| `call` | `const x = await fn(...inputs, { ...kwargs })` |
| `llm` | same as `call` but `_await` defaults true (treats result as Promise) |
| `ask` | `await ask(target, prompt, opts)` |
| `spawn` | `await spawn({ agent, role, ... })` |
| `input` | `const v = await userInput({ inputType, label, ... })` |
| `branch` | `if (cond) { yes-arm } else { no-arm }` |
| `loop` | `for (let i = 0; i < N; i++) { body }` (children render inside) |
| `parallel` | `await Promise.all([ (async()=>...)(), ... ])` (children render in parallel) |
| `return` | `return <expr>` (from `op` or incoming edge) |
| `note` / `callout` / `label` | rendered as a code comment |

Edges with `varName` carry data: codegen reads the source node's output
variable and passes it as a positional arg to the target.

---

## Live progress

While a run is in flight, the subprocess's stdout is streamed live to
`<run-dir>/stdout.log` and the browser tails it via
`/api/workflow/active-runs` + `GET /workflows/<ws>.runtime/runs/<id>/stdout.log`.
The runtime primitives emit one line per phase:

```
[userInput] waiting on label="URL"...
[userInput] got response after 4.7s
[ticket] filing role=generalist summary="research"...
[ticket] got tkt-xxx → session-20 (1.0s)
[ask] → session-20 (376 chars prompt)
[ask] ← session-20 (state=waiting_input, 12.6s)
[ticket] releasing 1 open ticket(s)...
[ticket] released
```

To add your own progress lines from a workflow helper, just
`console.log("[my-step] ...")`. Any output from inside the workflow body
flows through the same channel.

---

## Where the runnable examples live

| Example | Demonstrates |
|---|---|
| `content/workflows/example-ask-ticket` | `fileTicket` + `ask` + auto-cleanup |
| `content/workflows/example-user-input` | All four `userInput` types |
| `content/workflows/example-parallel-asks` | `parallel` kind + `Promise.all` |
| `content/workflows/example-message-handoff` | `writeJsonAtomic` + `waitForFile` (no bridge needed) |
| `content/workflows/agent-research-loop` | `branch`, real HTTP, persist artifacts |
| `content/workflows/telephone-game` | Six real LLM hops through one ticket |

Each example is a real workspace — open the page, click **Run**, watch
it execute. The progress tail will show every primitive call.
