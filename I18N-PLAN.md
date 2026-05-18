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

## Descoped — AI sidebar runtime strings

Originally task #2: i18n the runtime strings in `bridge-client.inline.ts`
(bridge status line, transient states, AI-comment chrome). **Cut** — the
user only wants the visible widget labels translated, which the SSR chrome
(done above) already covers. The live PTY/bridge runtime is left in English;
not worth the risk of refactoring that 1762-line critical file.

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

#3 → #4. The first one lands the shared `widgets/locale.ts` helper; the
second reuses it. Both are low-risk, self-contained React widgets.
