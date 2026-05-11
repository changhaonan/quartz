---
name: e2e-ui-test
description: Write and run a Playwright headless e2e test for any UI behavior in this project — sidebar persistence, SPA nav, widget mount/unmount, etc. Use BEFORE reporting a UI fix as done, NOT after the user asks "did you test it?"
allowed-tools: Bash, Write, Edit, Read
---

# e2e UI test (headless Playwright)

## When to use

Any time you change UI behavior and want to verify it actually works
without putting "test this in your browser" on the user. Especially:

- State persistence across reload (localStorage, sessionStorage, cookies)
- SPA navigation preservation
- Widget mount / unmount / re-mount
- Anything involving rebuild → reload → behavior survives
- Anything that touches the AI sidebar, the workflow widget, or bridge
  iframe embeds

If the change is server-side only (codegen, route emission, prompt
templates) this skill is overkill — `curl` + grep is enough. Reserve
it for things where the answer is in the **browser DOM** or in **JS
state**.

## Why this exists

Lesson learned 2026-05-11: I shipped a "fix" for sidebar PTY persistence
without testing it because I assumed I had no browser. Playwright was
already in `devDependencies`. The user called me on it. The fix even
had a bug (workspaceId fallback mismatch) that the e2e immediately
caught.

**Rule**: If `playwright` is in `package.json`, you can self-test the
behavior. Stop punting.

## Preconditions check

Run these first; if any fail, set them up before writing the test.

```bash
# Playwright installed?
node -e "require.resolve('playwright')" && echo "playwright ok" || npm install --save-dev playwright

# Staging stack running?
bash scripts/status.sh
# If staging not alive:
cd /path/to/quartz_pty_staging && bash scripts/run.sh staging
```

The test script MUST live inside the project tree (e.g.
`scripts/test-<feature>.mjs`) — not `/tmp/` — so Node resolves
`playwright` against the project's `node_modules`.

## Test skeleton

```js
import { chromium } from "playwright"
import { execSync } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"

const BASE = "http://127.0.0.1:8081"        // staging quartz
const BRIDGE = "http://127.0.0.1:3001"      // staging bridge
const TOUCH_FILE = "/abs/path/to/some/content/file.md"

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext()).newPage()
const fail = (m) => { console.error("X", m); process.exit(1) }
const ok = (m) => console.log("✓", m)

await page.goto(BASE + "/", { waitUntil: "domcontentloaded" })
await page.waitForSelector(".ai-sidebar", { timeout: 5000 })

// 1. Set up precondition state (cookies, localStorage, etc.)
// 2. Perform the action you're testing OR mimic prior session state
// 3. (Optional) trigger a rebuild:  execSync(`touch ${TOUCH_FILE}`)
//    then sleep(3000) so quartz dev server picks it up
// 4. Reload:  await page.reload({ waitUntil: "domcontentloaded" })
// 5. Assert: page.evaluate() the DOM / storage / iframe state

await browser.close()
```

## Critical correctness traps

1. **Match production fallback logic.** If the code resolves a key
   via `dataset.foo || dataset.bar || "default"`, your test must
   either set the dataset attributes accordingly OR compute the same
   fallback. Otherwise persist-key and resume-key differ and the
   test silently fails for the wrong reason.

2. **`waitUntil: "domcontentloaded"` is not enough for hydration.**
   The inline scripts (`postscript.js`) run async; their effects
   appear ~1-2s after DOMContentLoaded. Always `await sleep(2000)`
   between page load and assertions about hydrated state.

3. **Rebuild detection.** Quartz dev server watches `content/`. After
   `touch`, give it ~3s to rebuild. The browser's hot-reload WS will
   reload the page on its own — but for reproducibility, do an
   explicit `page.reload()` instead of relying on the WS signal.

4. **Run from project root.** Node ESM module resolution finds
   `playwright` by walking up from the script's directory. A script
   in `/tmp/` won't resolve to the project's `node_modules`. Always
   put the script under `scripts/`.

5. **Use `127.0.0.1`, not `localhost`** in URLs. The bridge's CORS
   allowlist accepts both, but mixed origins (`localhost:8080` page
   making fetches to `127.0.0.1:3001`) can confuse the browser's
   same-origin checks.

## Reference

Working example: [`scripts/test-sidebar-resume.mjs`](../../../scripts/test-sidebar-resume.mjs)
— full e2e for the localStorage-based PTY resume across rebuild +
refresh.

## Wiring as a regression test

After the test passes, add it to `package.json` so it runs on demand:

```json
"scripts": {
  "test:e2e": "node scripts/test-sidebar-resume.mjs"
}
```

Then `npm run test:e2e` from CI or before merging UI-touching PRs.
Do NOT add it to `npm run test` — Playwright tests need a live
staging stack and shouldn't run in a vanilla `npm test` context.
