# i18n rollout — remaining plan

Goal: every **client-side** widget/component follows the global language
toggle. Quartz's own build-time UI (`cfg.locale`) is intentionally out of
scope.

## Already done (committed `1ee6b75` on v4)

- **Global mechanism** — `quartz/components/Language.tsx` +
  `scripts/language.inline.ts`: the chrome language toggle keeps the locale
  on `<html data-lang>` + `localStorage["lang"]`, broadcasts a `langchange`
  CustomEvent (`detail.lang`).
- **Dashboard widget** — `quartz/widgets/dashboard/i18n.ts` (zh-CN / en-US
  table); renderer reads the global locale via a `StringsContext`, re-renders
  on `langchange`.
- **AI sidebar — SSR chrome** — `aiSidebar-i18n.ts`; static strings tagged
  `data-i18n` / `data-i18n-placeholder` / `data-i18n-label`; `bridge-client`
  applies them on load + `langchange`.

## The contract every consumer follows

- Read current locale: `document.documentElement.getAttribute("data-lang")`
  (`"zh-CN"` | `"en-US"`, default `"zh-CN"`).
- React to changes: `document.addEventListener("langchange", …)`,
  `e.detail.lang`.
- Each component owns its own string table (its strings are distinct);
  only the locale value + event are shared.

## Task #2 — AI sidebar runtime strings  (RISK: HIGH)

`quartz/components/scripts/bridge-client.inline.ts` — 1762 lines, the live
PTY/bridge runtime. A mistake breaks PTY sessions, so go section by section
and rebuild + smoke-test after each.

1. **Inventory** the user-visible runtime strings, in categories:
   - _State-driven, persistent_: bridge status (`probing`/`online`/`offline`),
     `data-ai-status` line, `.ai-sidebar__bridge-meta`, `.__runtime-meta`.
   - _Transient_: "Saving…", "Reading…", "…".
   - _AI-comment widget chrome_: "Reply… (Enter to send…)", "Dismiss",
     "★ to ask Jarvis · 💬 to add your own note on this page".
   - _Interpolated_: `PTY session ${id}`, `${agent} PTY ready for …` →
     these become functions in the table.
2. Extend `aiSidebar-i18n.ts` with these keys / functions.
3. Add a `lang()` accessor in the script; pull strings from the table at
   each assignment site (swap the literal, do **not** touch control flow).
4. **Re-render on `langchange`** — the hard part. State-driven elements must
   re-derive their text from current state: factor each status setter into a
   `render(state)` function, keep the last state in a module var, and have
   the `langchange` handler re-invoke the setters. Transient strings need no
   re-render (they flash).
5. Verify: AI-sidebar chrome probe still passes; `npm run test:e2e` (sidebar
   PTY resume) stays green; manually exercise start-PTY / AI-comment in both
   locales.

## Task #3 — workflow widget  (RISK: LOW)

`quartz/widgets/workflow/` — a React-runtime widget, same shape as the
dashboard. Mirror the dashboard exactly:

1. Survey the renderer's strings.
2. `quartz/widgets/workflow/i18n.ts` — `Strings` type + zh-CN / en-US.
3. `StringsContext` + `useStrings()`; read the global locale, re-render on
   `langchange`; swap literals → `t.*`.
4. **Factor a shared helper** while here: `quartz/widgets/locale.ts` with
   `readGlobalLocale()` + a `langchange` subscribe — the dashboard, AI
   sidebar, workflow and illustration all duplicate this glue today.
   Retrofit the dashboard onto it.
5. Verify: workflow e2e + a toggle probe.

## Task #4 — illustration widget  (RISK: LOW)

`quartz/widgets/illustration/` (and check `quartz/widgets/_canvas/`) — same
pattern as #3, reusing the shared `widgets/locale.ts` helper.

## Suggested order

#3 → #4 → #2. Doing a low-risk widget first lets the shared
`widgets/locale.ts` helper settle before the risky bridge-client refactor.
