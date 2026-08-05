# Renderable code fences

Most fenced code blocks are text with syntax colour. A few are worth _drawing_:
a `mermaid` fence is a diagram, an `interface` fence is an API contract. This is
the mechanism that lets a language opt into being drawn, without any other fence
noticing.

Everything lives in `ui/src/components/milkdown-editor/plugins/fence-render/`
and applies to the Milkdown surfaces only (`view` / `editor` / `learning`).
Review mode (react-markdown) and raw-markdown mode (Monaco) still show the
plain fence — the latter correctly, since it _is_ the source view.

## Render-only, by construction

The plugin adds no schema, no parser and no serializer. It is a ProseMirror
NodeView over the commonmark `code_block`, so a document's markdown is
byte-identical whether or not the plugin is loaded. A language with no
registered renderer falls through to the schema's own `toDOM` and behaves
exactly as it did before.

That property is what makes the feature safe to have at all, and it is worth
preserving: any future change that needs to _write_ through a fence should go
through `commit` (below) rather than touching the schema. Being a `$view` and
not a `$nodeSchema` override also sidesteps the double-override crash
documented in `plugins/bidi/schema.ts`.

## The registry

`registry.ts` holds a `Map<language, FenceRenderer>`. A renderer declares its
info string, a tab label, an optional `layout` (`centered` for a figure,
`block` for document-width content), and a `render(code, host, ctx)` that turns
source text into DOM.

Renderers **self-register at module scope**; the plugin's `index.ts` never
imports them. `MilkdownEditor.tsx` — the composition point — imports the
concrete renderer modules for their side effect, the same direction
`AssetsPage` loads its column modules. Registering them inside the plugin would
make the generic layer depend on every implementation of it.

The contract is throw-based: a renderer that cannot draw its input throws, and
the host keeps the last good output and shows an inline error chip below both
panes. Keeping validation feedback outside the render pane matters: malformed
YAML remains fully editable in Code while the precise parser/schema error stays
visible. A half-typed block degrades to "stale render + error" instead of
flashing blank.

## Tabs, and where their state lives

Every renderable fence gets a two-tab strip — the renderer's label, and `Code`.
Tab state is **view state**, so it lives in neither the document (writing it to
markdown would break the round-trip) nor the NodeView (ProseMirror destroys and
recreates those freely). It lives in plugin state as a map of explicit user
picks keyed by document position, remapped through `tr.mapping` on every
transaction so the key survives edits above the block.

The plugin emits a `Decoration.node` carrying `spec.fenceMode`, which is also
what makes ProseMirror call `NodeView.update` — one mechanism drives both the
state and the view.

**Caret precedence**: a caret inside the block always forces `Code`. If the
source were hidden while the selection sat inside it, the caret would have
nowhere to render and typing would go somewhere invisible. Switching _to_ the
render tab moves the selection out of the node first.

## Host services

A NodeView is plain DOM with no React tree, so anything it needs from the app is
handed in through a Milkdown `$ctx` slice (`host-services.ts`), read per render
so the values stay live: open a file, preview a file, locate a project. These
are app primitives — nothing there knows what an interface block is.

`ctx.editable` mirrors the host document's editability. Renderers must honour
it: their controls sit in a `contenteditable="false"` pane, outside
ProseMirror's own editable check, so nothing else stops a user editing a
read-only document (the vibe display, any `view`-mode asset). `commit` refuses
the write too, as defence in depth.

## The three renderers

**`mermaid`** draws diagrams, lazily importing a heavy dependency and
re-rendering on theme change. The whiteboard editor already writes these blocks
into documents, so this closes a loop the app was half-way through.

**`interface`** renders an API/function-signature card from YAML, with inline
editing: values are click-to-edit and the optional badge is a toggle. Edits
rewrite the block through `yaml`'s Document API rather than regenerating it, so
comments, key order and quoting survive.

**`breadcrumb`** renders the tests a rules doc governs — see [Live refresh](#live-refresh)
below, and the `tagit` skill that writes these blocks.

The Code pane is the authoritative structural editor in Editor mode: it is the
real ProseMirror code-block content, not a detached textarea, so typing, undo,
autosave and Markdown serialization follow the ordinary document path. View
mode shows the same source read-only. Existing top-level and member
descriptions are editable in the rendered card; adding/removing fields or
promoting a compact scalar to object form remains a Code-pane edit.

An interface may describe either a callable (`params`, `returns`, `errors`) or a
class-like surface with `methods` and `properties`. Class-like cards gain two
sub-tabs inside the Interface pane; switching them is view state and never
writes to the document. Both collections accept a compact scalar, while
described properties use `{type, description}` and described methods use
`{signature, description}`:

```yaml
name: AgenticProcess
properties:
  status:
    type: ProcessStatus
    description: Current lifecycle state.
methods:
  start: 'async (prompt?: string) -> ApiResponse'
  close:
    signature: 'async () -> void'
    description: Permanently tear down the process.
```

If either class-member collection is present, both tabs are available. The
renderer opens Methods when methods exist, otherwise Properties; selecting an
empty sibling tab shows a short empty state. Callable-only fences retain their
existing layout with no member tabs.

## Source grounding

An `interface` block may carry a `source` pointer — where the contract is
implemented — so the card stops being free-floating prose:

```yaml
source:
  origin: # the SDK's FSOriginField union; omit `kind` → git
    kind: git
    provider: github
    owner: langware
    name: flowpad
    branch: main
    rel_path: flow_sdk/api/tasks.py
  line: 42
```

The origin is read through the SDK's own `normalizeFSOrigin`, so a hand-authored
block and a backend-persisted origin obey identical rules — including the
missing-`kind`-means-git tolerance the backend discriminator uses. `rel_path` is
checked with the shared `isSafeRelPath`, because the frontend and backend must
agree on what a safe repo-relative path is.

`source-location.ts` resolves an origin to a local path, in precedence order:
an explicit `project_id`, then a local origin's own `base`, then the document's
project root. Each failure returns a _reason_ rather than throwing — that reason
is what the disabled chip's tooltip shows, because a dead control that explains
nothing is worse than no control.

The card renders one chip: icon plus provenance, click to peek. The peek is
`FilePreviewSheet` (see [display-capabilities.md](display-capabilities.md)),
which mounts the real editor read-only, so scroll-to-line and the deep-link
marker are the same code the full editor runs. The chip is deliberately **not**
gated on `ctx.editable` — navigating is a read action, and a read-only surface
is where following a contract to its source matters most.

## Live refresh

`breadcrumb` is the first fence whose content is not entirely in the block. It
names a tag and carries the sites the `tagit` skill knew about:

```breadcrumb
tag: breadcrumb.test.catchup_login.rules
sites:
  - rel_path: tests/unit/test_catchup.py
    line: 41
    note: FAILING? read this tag's rules before editing
```

Those rows draw immediately; the tag index is then asked what is bound *now*
(`POST /api/v1/tags/context`, the same join behind `flow tag get`) and its
answer replaces them. The authored list is a cache of something the index owns,
so it is never authoritative — but it is what makes the card useful with no
backend, and what a test rename cannot invalidate.

Both halves produce the same row shape, which is the point: `scan_code_capsules`
walks one root and reports paths relative to it, exactly like a hand-authored
`rel_path`. `resolveRelPath` in `source-location.ts` is the single join rule
they share — extracted from `resolveSourceLocation`, whose only difference is
that an *origin* picks its root while a breadcrumb site is handed one.

Four constraints shape `breadcrumb-context.ts`, and none of them are optional:

* **`render()` is synchronous.** It is re-invoked on every theme change, every
  editable flip, and every 150 ms debounce tick while the author types — and is
  handed a fresh host each time. Nothing survives in a renderer closure, so the
  join lives at module scope keyed by `(tag, root)`. A theme toggle then costs
  zero requests and N fences sharing a tag cost one walk.
* **The fetch never throws.** A rejection reaching the NodeView would trip
  `lastRenderFailed` and blank the authored rows — punishing the author for a
  backend being down. Failures surface in the card's own status line instead;
  the `fence-render-error` chip keeps meaning "your source is wrong".
* **Failures are cached too**, on the same TTL. The `code` half of that route is
  a live gitignore-respecting filesystem walk; without negative caching an
  unreachable backend turns the typing debounce into a storm against the most
  expensive endpoint in the join.
* **An empty answer does not clear the rows.** `root` is the *document's*
  project, which may not be the repo holding the test. "I looked here" is not
  "there are none".

The repaint is a one-shot callback guarded on `host.isConnected` — the NodeView
attaches a host only after a successful render, so a superseded render's host
stays detached forever and its callback is a no-op. That is what makes this safe
without a `destroy()` hook on `FenceRenderer`.

The response's `docs[]` is deliberately **not** rendered. For a
`breadcrumb.test.*` tag that list is exactly one document — the page you are
reading — so a chip there links to itself. The card answers "which tests does
this doc govern"; if a tag ever needs its whole join drawn, that is a different
fence.

`tagit` puts the block at the top of a rules doc, which makes a fence the
document's **first node** — a position worth keeping in mind when changing the
NodeView, and one the jsdom fixtures deliberately avoid.

<!-- flowpad:capsule identity
version: 1
data:
  id: 64a4f7de-c410-456c-a76a-55f67fd8ae43
flowpad:endcapsule identity -->
