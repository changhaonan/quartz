# quartz/widgets

First-class subsystem of the `quartz_pty` fork. Hosts file-scoped
interactive widgets (illustration boards, blueprint canvases, evaluation
boards, etc.) whose data lives in sibling `.runtime/*.json` files and
whose mutations flow through the bridge content write API.

## Layout

```
widgets/
  types.ts                 // Widget, WidgetMountContext, JsonPatchOp, ...
  registry.ts              // registerWidget / getWidget
  client.ts                // fetchWidgetData / writeWidget
  bootstrap.inline.ts      // runtime entry: scans DOM, mounts widgets
  index.ts                 // public exports + side-effect imports
  <name>/
    schema.ts              // zod schema (build + runtime)
    renderer.tsx           // preact mount fn
    styles.scss
    index.ts               // registerWidget(...)
```

## Discipline (load-bearing)

1. **No reverse imports.** A file under `widgets/` MUST NOT import from:
   - `quartz/components/`
   - `quartz/plugins/`
   - any SSG-time module (rehype/remark plugins, esbuild config, etc.)

   Allowed imports: preact, zod, third-party libs, sibling `widgets/*` files.

   Reason: this subsystem is intended to be importable from outside the
   Quartz build (e.g., the bridge dashboard) without dragging in the SSG.

2. **Renderers are pure.** `mount(ctx)` should accept already-validated
   data, render to `ctx.el`, and return a dispose function. No build-time
   side effects, no global state.

3. **Reads are stateless fetches.** No assumption that the bridge is
   running. Widgets must render in `readonly` mode from a static file.

4. **Writes go through the bridge.** Never `fetch(src, { method: "PUT" })`
   or talk to a database directly. Use `ctx.write(...)`, which routes
   through the M6 file-runtime write API with locking and atomic publish.

5. **Schema is one source of truth.** A widget's zod schema is consumed
   by:
   - the runtime bootstrap (validates fetched data before mount),
   - the build-time validator (catches bad data before publish),
   - bridge write handlers (validates patch results),
   - downstream consumers (TS type via `z.infer`).

   Don't duplicate schemas in TypeScript interfaces.

6. **Schema versions are explicit.** Every widget exports
   `schemaVersion: number`. Markdown widget blocks may pin a version. The
   bootstrap refuses to mount on mismatch rather than silently rendering
   garbage.

## Adding a widget

1. Create `widgets/<name>/` with `schema.ts`, `renderer.tsx`,
   `styles.scss`, `index.ts`.
2. In `index.ts`, call `registerWidget({...})`.
3. Append `import "./<name>"` to `widgets/index.ts`.
4. Reference it from Markdown:

   ```markdown
   ```widget
   type: <name>
   src: ./<file>.runtime/<name>.json
   mode: live
   ```
   ```
