import { chromium } from "playwright"

const url = process.argv[2] || "http://localhost:8080/boards/illustration-board"

const headless = process.env.PROBE_HEADLESS !== "0"
const browser = await chromium.launch({ headless })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()

const consoleEvents = []
const networkEvents = []

page.on("console", (msg) => {
  consoleEvents.push({ type: msg.type(), text: msg.text() })
})
page.on("pageerror", (err) => {
  consoleEvents.push({
    type: "pageerror",
    text: `${err.name}: ${err.message}\n${err.stack ?? ""}`,
  })
})
page.on("requestfailed", (req) => {
  networkEvents.push({
    kind: "requestfailed",
    method: req.method(),
    url: req.url(),
    error: req.failure()?.errorText,
  })
})
page.on("response", (res) => {
  const u = res.url()
  if (u.includes("/api/") || u.includes("bridge") || u.includes("/board.json")) {
    networkEvents.push({
      kind: "response",
      method: res.request().method(),
      url: u,
      status: res.status(),
    })
  }
})

console.log(`navigating to ${url}`)
await page.goto(url, { waitUntil: "networkidle", timeout: 30000 })
await page.waitForTimeout(1500)

const widgetState = await page.evaluate(() => {
  const el = document.querySelector(".quartz-widget")
  if (!el) return { found: false }
  return {
    found: true,
    state: el.getAttribute("data-widget-state"),
    workspaceId: el.getAttribute("data-workspace-id"),
    bridgeOrigin: el.getAttribute("data-bridge-origin"),
    mode: el.getAttribute("data-widget-mode"),
  }
})

const flowState = await page.evaluate(() => {
  const flow = document.querySelector(".react-flow")
  if (!flow) return { found: false }
  const nodes = Array.from(flow.querySelectorAll(".react-flow__node")).map((n) => {
    const r = n.getBoundingClientRect()
    return {
      id: n.getAttribute("data-id"),
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    }
  })
  return { found: true, nodeCount: nodes.length, nodes: nodes.slice(0, 4) }
})

console.log("\n=== widget state ===")
console.log(JSON.stringify(widgetState, null, 2))
console.log("\n=== react-flow state ===")
console.log(JSON.stringify(flowState, null, 2))

// Install a MutationObserver inside the page to capture every status
// text/class change with timestamps, so we can see flashes like
// "saving -> saved (green) -> error (red)" that pure post-drag polling
// would miss.
await page.evaluate(() => {
  const status = document.querySelector(".illustration-board-frame__status")
  window.__statusChanges = []
  if (!status) return
  const record = () => {
    window.__statusChanges.push({
      t: performance.now() | 0,
      text: status.textContent,
      classes: Array.from(status.classList),
    })
  }
  record()
  new MutationObserver(record).observe(status, {
    characterData: true,
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  })
})

let dragResult = "skipped (no nodes)"
if (flowState.found && flowState.nodes.length > 0) {
  dragResult = "real-pointer drag (above)"

  console.log("\n=== add a process node ===")
  const addRes = await page.evaluate(() => {
    if (typeof window.__illustrationDebugAdd !== "function") return { ok: false }
    return { ok: window.__illustrationDebugAdd("process") }
  })
  console.log(JSON.stringify(addRes))
  await page.waitForTimeout(2000)

  console.log("\n=== add an edge between two existing nodes ===")
  // Use the hook indirectly: dispatch an `onConnect` via the IllustrationCanvas's
  // own callback path through the rf-events flow. Easiest: simulate the same
  // path React Flow takes — read source/target ids and call onChange directly.
  const edgeAdd = await page.evaluate(() => {
    // Find first two nodes by reading currently rendered DOM
    const nodes = Array.from(document.querySelectorAll(".react-flow__node"))
      .map((el) => el.getAttribute("data-id"))
      .filter(Boolean)
    if (nodes.length < 2) return { ok: false, reason: "need 2 nodes" }
    // Trigger onConnect by directly invoking through window hook.
    // (We don't have a direct add-edge hook, but onChange flows are exposed via
    //  __illustrationDebugMove which only handles position. So this is a gap
    //  in instrumentation — fall back to verifying via fetch.)
    return { ok: true, source: nodes[0], target: nodes[1] }
  })
  console.log(JSON.stringify(edgeAdd))

  console.log("\n=== run ELK auto-layout ===")
  const layoutRes = await page.evaluate(async () => {
    if (typeof window.__illustrationDebugLayout !== "function") return { ok: false }
    await window.__illustrationDebugLayout()
    return { ok: true }
  })
  console.log(JSON.stringify(layoutRes))
  await page.waitForTimeout(4000)

  console.log("\n=== select first node + delete ===")
  await page.evaluate(() => {
    const node = document.querySelector(".react-flow__node")
    if (!node) return
    const rect = node.getBoundingClientRect()
    node.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        buttons: 1,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      }),
    )
    node.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        buttons: 0,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      }),
    )
  })
  await page.waitForTimeout(500)
  const deleteRes = await page.evaluate(() => {
    if (typeof window.__illustrationDebugDelete !== "function") return { ok: false }
    return { ok: window.__illustrationDebugDelete() }
  })
  console.log(JSON.stringify(deleteRes))
  await page.waitForTimeout(2500)

  const finalStats = await page.evaluate(() => ({
    nodes: document.querySelectorAll(".react-flow__node").length,
    edges: document.querySelectorAll(".react-flow__edge").length,
  }))
  console.log("final canvas counts:", JSON.stringify(finalStats))
}

// Try a real user-style drag via Playwright's hover + mouse events.
// Scroll the canvas into view first, then find the first non-decorative
// node and drag it 60px right.
console.log("\n=== real-user drag attempt ===")
await page.evaluate(() => {
  document.querySelector(".react-flow")?.scrollIntoView({ block: "center" })
})
await page.waitForTimeout(300)
const dragOutcome = await page.evaluate(() => {
  const node = document.querySelector('.react-flow__node[data-id="goal"]')
  if (!node) return { error: "no node" }
  const r = node.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
console.log("node rect:", JSON.stringify(dragOutcome))
if (dragOutcome.x !== undefined) {
  await page.mouse.move(dragOutcome.x + dragOutcome.w / 2, dragOutcome.y + dragOutcome.h / 2)
  await page.mouse.down()
  await page.waitForTimeout(50)
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(
      dragOutcome.x + dragOutcome.w / 2 + i * 5,
      dragOutcome.y + dragOutcome.h / 2 + i * 4,
    )
    await page.waitForTimeout(20)
  }
  await page.mouse.up()
  await page.waitForTimeout(2000)
}
const rfEvents = await page.evaluate(() => window.__rfEvents || [])
console.log("react-flow events fired:")
for (const e of rfEvents) console.log(`  +${e.t}ms ${JSON.stringify(e)}`)

console.log("\n=== drag diagnostics ===")
const dragDiag = await page.evaluate(() => {
  const node = document.querySelector(".react-flow__node")
  if (!node) return { error: "no react-flow node" }
  const style = getComputedStyle(node)
  // Check what's at the center of the node — does anything cover it?
  const rect = node.getBoundingClientRect()
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const stack = []
  let target = document.elementFromPoint(cx, cy)
  while (target && stack.length < 5) {
    stack.push({
      tag: target.tagName,
      class: target.className?.toString?.().slice(0, 80),
      pointerEvents: getComputedStyle(target).pointerEvents,
    })
    target = target.parentElement
  }
  // Inspect React Flow's inner draggable expectation
  const reactFlowNode = node
  const handle = reactFlowNode.querySelector(".canvas-illustration-node")
  return {
    nodeRect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    nodeClass: node.className?.toString?.(),
    nodePointerEvents: style.pointerEvents,
    nodeUserSelect: style.userSelect,
    nodeTouchAction: style.touchAction,
    nodeAttrs: {
      "data-id": node.getAttribute("data-id"),
      "draggable": node.getAttribute("draggable"),
    },
    elementsAtCenter: stack,
    hasInnerHandle: !!handle,
  }
})
console.log(JSON.stringify(dragDiag, null, 2))

// Original drag-via-pointer-events path is left below for reference but
// no longer drives the test (React Flow's drag isn't reliably triggered
// from headless playwright pointer events).
const skipPointerDrag = true
if (!skipPointerDrag && flowState.found && flowState.nodes.length > 0) {
  const first = flowState.nodes[0]
  console.log(`\n=== drag attempt on node ${first.id} ===`)
  networkEvents.length = 0
  consoleEvents.length = 0
  await page.evaluate((id) => {
    const node = document.querySelector(`.react-flow__node[data-id="${id}"]`)
    if (!node) return { error: "node not found" }
    const rect = node.getBoundingClientRect()
    const sx = rect.x + rect.width / 2
    const sy = rect.y + rect.height / 2
    const fire = (type, x, y) => {
      const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        buttons: 1,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
      })
      node.dispatchEvent(event)
    }
    fire("pointerdown", sx, sy)
    for (let i = 1; i <= 10; i++) {
      fire("pointermove", sx + i * 6, sy + i * 4)
    }
    fire("pointerup", sx + 60, sy + 40)
    return { ok: true, sx, sy }
  }, first.id)
  await page.waitForTimeout(3000)

  // Second drag — to see if the second write fails (user's observation)
  console.log(`\n=== second drag on node ${first.id} ===`)
  await page.evaluate((id) => {
    const node = document.querySelector(`.react-flow__node[data-id="${id}"]`)
    if (!node) return
    const rect = node.getBoundingClientRect()
    const sx = rect.x + rect.width / 2
    const sy = rect.y + rect.height / 2
    const fire = (type, x, y) => {
      node.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: "mouse",
          button: 0,
          buttons: 1,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y,
        }),
      )
    }
    fire("pointerdown", sx, sy)
    for (let i = 1; i <= 10; i++) {
      fire("pointermove", sx + i * 5, sy - i * 3)
    }
    fire("pointerup", sx + 50, sy - 30)
  }, first.id)
  await page.waitForTimeout(3000)
  dragResult = "two drags via dispatched pointer events"
}

const statusChanges = await page.evaluate(() => window.__statusChanges || [])
console.log(`\n=== status change timeline (${statusChanges.length} events) ===`)
for (const c of statusChanges) {
  console.log(`+${c.t}ms text=${JSON.stringify(c.text)} classes=${JSON.stringify(c.classes)}`)
}
console.log(`\n=== drag result: ${dragResult} ===`)

const statusAfterDrag = await page.evaluate(() => {
  const status = document.querySelector(".illustration-board-frame__status")
  return status ? status.textContent : null
})
console.log(`status after drag: ${JSON.stringify(statusAfterDrag)}`)

console.log("\n=== network events (post-drag) ===")
for (const e of networkEvents) {
  console.log(JSON.stringify(e))
}

console.log("\n=== console events (post-drag) ===")
for (const e of consoleEvents.slice(-10)) {
  console.log(`[${e.type}] ${e.text.slice(0, 400)}`)
}

// Directly verify the write endpoint exists, regardless of whether
// drag fires in headless. This is the network call drag would make.
console.log("\n=== direct write-endpoint probe ===")
const writeResult = await page.evaluate(
  async ({ origin, workspaceId, path }) => {
    try {
      const res = await fetch(`${origin}/api/file-runtime/write`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          path,
          patch: [{ op: "replace", path: "/nodes/0/x", value: 999 }],
        }),
      })
      let body = ""
      try {
        body = (await res.text()).slice(0, 400)
      } catch {}
      return { ok: res.ok, status: res.status, statusText: res.statusText, body }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  },
  {
    origin: widgetState.bridgeOrigin || "http://127.0.0.1:3210",
    workspaceId: widgetState.workspaceId,
    path: "boards/illustration-board.runtime/board.json",
  },
)
console.log(JSON.stringify(writeResult, null, 2))

// If this looks like a workflow page, verify codegen by clicking Export TS.
const exportProbe = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button"))
    .find((b) => b.textContent && b.textContent.trim().startsWith("Export TS"))
  if (!btn) return { found: false }
  btn.click()
  const pre = document.querySelector(".workflow-board__code-body")
  return {
    found: true,
    source: pre ? pre.textContent : null,
  }
})
if (exportProbe.found) {
  console.log("\n=== generated TypeScript ===")
  console.log(exportProbe.source)
}

await page.screenshot({ path: "/tmp/illustration-screenshot.png", fullPage: true })
console.log("\nscreenshot saved to /tmp/illustration-screenshot.png")

await browser.close()
