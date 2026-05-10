import { chromium } from "playwright"

const url = process.argv[2] || "http://localhost:8080/boards/illustration-board"

const browser = await chromium.launch({ headless: true })
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
  console.log(`\n=== first save via debug hook ===`)
  networkEvents.length = 0
  consoleEvents.length = 0
  const firstSave = await page.evaluate(() => {
    if (typeof window.__illustrationDebugMove !== "function") return { ok: false, reason: "hook not present" }
    return { ok: window.__illustrationDebugMove(0, 200, 200) }
  })
  console.log(JSON.stringify(firstSave))
  await page.waitForTimeout(2500)

  console.log(`\n=== second save via debug hook ===`)
  const secondSave = await page.evaluate(() => {
    if (typeof window.__illustrationDebugMove !== "function") return { ok: false, reason: "hook not present" }
    return { ok: window.__illustrationDebugMove(0, 250, 250) }
  })
  console.log(JSON.stringify(secondSave))
  await page.waitForTimeout(2500)
  dragResult = "two saves via debug hook"
}

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

await page.screenshot({ path: "/tmp/illustration-screenshot.png", fullPage: true })
console.log("\nscreenshot saved to /tmp/illustration-screenshot.png")

await browser.close()
