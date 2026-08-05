# Breadcrumb fence — a rules doc's bound tests, in a real browser

The first browser coverage of ANY renderable fence. Everything else about
`fence-render/` is pinned in jsdom (`ui/tests/unit/fence-render-*.test.ts`),
which cannot prove the three things that only exist in the running app: that
the renderer is actually registered in the shipped editor, that the live
refresh reaches a real backend, and that a chip click opens the real
`FilePreviewSheet`.

Written by the `tagit` skill; see `.claude/skills/tagit/SKILL.md` and
`docs/renderable-fences.md`.

## Setup

Needs a running instance. Either the checkout's own dev stack, or an isolated
one:

```bash
scripts/instance_ctl.sh launch dev-1      # → frontend :5001, backend :6001
```

Run with the ports of whichever stack you used — the config defaults
`VITE_PORT` to 4097, but this checkout runs 4098:

```bash
cd ui && VITE_PORT=4098 npx playwright test \
  --config=tests/manual_regression/editor/playwright.config.ts \
  tests/manual_regression/editor/breadcrumb_fence.md.ts
```

The fixture writes two files into the active project's mount path (a Python
file carrying a real `tag` capsule, and a markdown doc whose body is a
```breadcrumb fence naming it) and deletes both afterwards.

## Scenarios

### 1. The authored rows render and resolve

1. Open the seeded doc at `/dock/assets/editor/markdown/typeid/markdown-<id>`.
2. **Expect** a `breadcrumb-card` showing the tag.
3. **Expect** the first site chip labelled `<rel_path>:<line>` — the values the
   block itself carries, drawn before any backend answer.

### 2. A chip peeks at the test

1. Click the first site chip.
2. **Expect** the file-preview sheet to open on that file.

This is the whole point of the feature: from a rules doc, one click to the test
the rules govern, at the capsule's line.

### 3. It stays clickable on a read-only surface

1. Switch to `view` mode.
2. **Expect** the chip still enabled and still opening the preview.

Deliberate: nothing on this card mutates the document, and a read-only surface
is where following a breadcrumb matters most. A regression here would most
likely come from someone "correctly" gating the card on `ctx.editable`.

### 4. The live refresh replaces the authored rows

1. Wait for the provenance pill to read `live` (`data-provenance="live"`).
2. **Expect** the chip to name the file that actually carries the capsule.

This is the half jsdom cannot fake: a real `POST /api/v1/tags/context`, a real
`scan_code_capsules` walk of the project root, and the repaint landing in a
host the NodeView has already attached.

If this scenario alone fails while 1–3 pass, suspect the project root rather
than the renderer: the walk is rooted at the *document's* project, and the card
correctly keeps its authored rows when the answer comes back empty.

### 5. The source round-trips

1. Switch to the `Code` tab of the fence.
2. **Expect** the original YAML, byte-identical.

The plugin adds no schema, parser or serializer; a document's markdown must be
unchanged by the fence being rendered at all.
