# Philosophy

The design rules `quartz_pty` is built around. Some are inherited from
Quartz upstream; most reflect what fell out of the fork.

## Two repos, two roles

**`quartz_pty` is the front-end and orchestration surface.**
It owns shell, graph, search, backlinks, file navigation, the workflow
widget, and the AI sidebar.

**`claude_pty` is the long-running backend.**
It owns PTY sessions, agent memory, the inbox/ticket event log,
content write authority, and the rebuild queue. Anything dangerous or
stateful lives here.

The split is firm: `quartz_pty` doesn't write content files directly —
it asks the bridge. The bridge doesn't render markdown — it serves
data. New features must respect this boundary; in particular, **do
not bake heavy-bridge-UI assumptions into `quartz_pty`**. The bridge
is a backend, not a peer surface.

## Code and content are different repos

The outer `quartz_pty` git tracks code. The `content/` directory is its
own independent git repo, gitignored from the outer tree. This is so:

- Notes / workflows / boards can be versioned separately from the
  rendering code
- Multiple environments (prod, staging, dev) can run the same code
  against different content trees
- Promotion of "what's in the site" and "what's in the codebase" are
  independent operations

This is why the prod/staging worktrees each have their own `content/`
clone — they share code via git worktree, but they don't share data.

## API-driven control, not screen scraping

When a workflow hands a task to an agent, the handoff signal is **an
explicit HTTP POST** (the agent calls `/api/sessions/:id/inbox/ack`).
Not a regex match on the terminal scrollback. Not a file mtime. Not a
sentinel string. The agent says "I'm done"; we believe it.

Output files are *data*, not signal. The ack is the signal. This is
the difference between "the orchestrator infers state from the
agent's UI" (brittle, timing-dependent) and "the orchestrator and the
agent share a documented contract" (durable). When in doubt, prefer a
new API endpoint over a clever string match.

## Files declare runtime workspaces

A markdown page can own a sibling `.runtime/` folder. Inside it lives
state for that page's widget: `workflow.json`, `messages/`, `runs/`,
`handoffs/`. The page is the workspace. The folder is the data.

This means **artifacts write into the owning file's folder** — never
to a global temp dir, never to a sibling page's tree. Cleanup is
trivial (`rm -rf foo.runtime/`); migration is trivial (move both
together). The widget framework reads schemas from `.runtime/` files
at load; bad data fails or warns the build.

## One rebuilder

`npx quartz build` is not safe to run concurrently — the output
directory is shared mutable state. The bridge owns a single rebuild
queue and runs at most one build at a time. Agents and widgets that
need a fresh site queue a rebuild request and wait; they do not spawn
their own builds.

Successful builds publish atomically (build into temp, swap on
success). A failing build leaves the previous site serving — there is
no window where readers see a half-built tree.

## Run TypeScript source, not a build artifact

The static-site generator bundles content. The *runtime layer* — the
dev server, the workflow subprocess, the CLI — runs `.ts` directly via
Node's loader. There is no `dist/` for the runtime. The advantages:

- Same code in dev, staging, and prod (no "what shipped vs what's in
  the source tree" gap)
- A green staging proves prod
- Stack traces point at real files, not at bundled output

`tsc --noEmit` runs as a type gate (`npm run check`) but never blocks
a deploy. Promotion is a `git checkout`, not a build pipeline.

## Fork-diverge is allowed

`quartz_pty` is a fork of Quartz v4. We modify core Quartz files when
it's the right thing to do — there's no rule that says
"only touch `quartz/widgets/`". The fork exists *because* upstream
Quartz isn't the right shape for multi-agent workflow orchestration;
forcing every change into a plugin would be more pain than it's
worth.

That said: gratuitous churn in upstream code makes future merges
painful. The bar for editing core Quartz is "the change is justified
by something that can't be cleanly built outside it." When it is,
edit; when it isn't, don't.

## Optimize for long-term

Minimum-viable is a trap. The features we build live for years; the
question is "what will this look like when someone touches it in six
months," not "what's the shortest path to a green test today." Two
extra hours spent on the right abstraction pays back many times over.

Inverse of the rule: **don't speculate.** Three similar lines is
better than a premature abstraction. The "what does this look like in
six months" question is about avoiding load-bearing hacks, not about
inventing imaginary future requirements.

## Terse and direct

In code and in communication: short sentences, no filler, no
hand-waving about "robustness" or "extensibility." If a comment isn't
explaining a non-obvious *why* (a hidden constraint, a workaround, an
invariant), it shouldn't exist. If a paragraph in a doc can be one
sentence, it should be.

The static site is a record of decisions. Decisions that read clearly
are easier to revisit; decisions buried under prose rot in place.
