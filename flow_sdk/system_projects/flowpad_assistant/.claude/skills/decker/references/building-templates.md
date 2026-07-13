# Building a deck template

## 1. Copy the scaffold

```bash
cp -R "<this skill's directory>/template/." "<project root>/assets/deck-templates/<template name>/"
```

`<template name>` is short kebab-case, derived from what the user asked for
(or the name they gave). The scaffold ships six exemplar layouts
(cover-centered, agenda-list, content-single-column, media-full-bleed,
metrics-grid, closing-centered), `common/` tokens+theme, vendored Reveal, and
the assembler. Copy verbatim — the slot contract, theme classes, and assembler
agree with each other; hand-rolled folders drift.

## 2. Ask which page types to support (MCP UI multi-select)

Inside FlowPad, ask via an interactive multi-select rather than prose. Follow
the `mcp-ui` skill's output contract (the `.mcp.html` + inline JSON-RPC bridge
pattern documented there) with this decker-specific shape:

- Write `<scratchpad>/decker-page-types.mcp.html` — a multi-select of the **17
  page types** from [layouts.md](layouts.md), one option per page type, its
  layout names shown as the option detail. Test IDs:
  `data-testid="mcp-ui-multiselect-<page type>"`. Pre-check a sensible core
  (cover, agenda, content, media, metrics, closing — plus any the user's
  request implies). Include one open-text field
  (`data-testid="mcp-ui-open-question"`) asking for design-language wishes
  (brand colors, tone).
- Present it: `flow show file <absolute path>.mcp.html` (exit 0 = shown), then
  **stop and wait** for the submission message (text starting
  `MCP_UI_SUBMISSION ` with JSON like
  `{"selectedOptions": ["cover", "metrics", …], "openQuestion": "…"}`).
- Acknowledge with `MCP_UI_RECEIVED` and proceed with exactly the selected
  page types.

Outside FlowPad (no Vibe display), ask the same question as a plain message
listing the page types.

## 3. Generate the selected layouts

For each selected page type, ensure its **required layouts** (table in
[layouts.md](layouts.md)) exist under `layouts/`:

- Already shipped by the scaffold → keep as-is (restyle only via tokens).
- Missing → write `layouts/<layout name>.html` following the slot contract and
  that layout's slot inventory in layouts.md. Start from the closest exemplar
  (same repeatable/media pattern). Delete exemplar layouts whose page type was
  NOT selected only if the user asks — extra layouts are harmless.
- Apply the user's design-language wishes by editing `common/tokens.css`
  (colors, type, spacing) — not the layout files.

Preview each new layout by building a one-slide deck with placeholder fills
(see [generating-decks.md](generating-decks.md)) and `flow show file` it.

## 4. Write the manifest and index

Update `template.json` (two-section doc; don't add an `id` — the indexer mints
one via the `.flow/id` capsule):

```json
{
  "metadata": {
    "title": "<Template title>",
    "description": "<one line: design language + intended use>",
    "page_types": ["cover", "agenda", "…the selected ones"],
    "reveal_version": "5.2.1"
  },
  "data": {}
}
```

Then index the **project root** (not the template folder — the walker scans
`<root>/assets/deck-templates/`, so indexing the template folder finds nothing):

```bash
flow record index "<project root>"
```

The folder becomes a `deck_template` entity (layout list is scanned from disk
at index time). Keep the template's `CLAUDE.md`/`AGENTS.md` — they route
future sessions back through this skill.

## Adding layouts to an existing template

Same as step 3: write the fragment per the slot inventory, preview with a
one-slide deck, then re-run `flow record index "<project root>"` so the
entity's layout list updates.
