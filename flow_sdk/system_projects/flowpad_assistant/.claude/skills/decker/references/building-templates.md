# Building a deck template

The style is already chosen by the time you get here — the one-click picker in
[SKILL.md](../SKILL.md) runs first. If it hasn't run and the design is
undecided, go back and run it.

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

If the folder already exists, this is not a bootstrap: check
`common/theme.css` for the `decker:structural-fix` marker and repair it first
(see [SKILL.md](../SKILL.md)).

## 2. Apply the chosen style

```bash
S="<this skill's directory>/styles/<style slug>"
T="<project root>/assets/deck-templates/<template name>/common"
cp "$S/tokens.css" "$T/tokens.css"
cp "$S/style.css"  "$T/style.css"
```

That's the whole design step. Do not hand-write a palette — see
[styles.md](styles.md) for the three-layer contract and why `--font-display`
carries most of the weight.

**Tuning on top.** If the user named brand colours or a tone, apply the style
first and then edit `common/tokens.css` (usually just `--accent`, `--bg`,
`--text`). The style is the floor, not the ceiling. Reach for `style.css` only
to change what a component *is* (a card becoming a ruled column); reach for a
layout file only if it has hardcoded design that should not be there.

## 3. Layouts — the core six are the default

The scaffold already ships the core six page types (cover, agenda, content,
media, metrics, closing). **That is the default: take it and keep moving.** The
whole point of the one-click picker is that a deck needs exactly one question.

Only when the request actually needs other page types (a roadmap, the team, a
comparison) do more:

- Required layouts per page type → the table in [layouts.md](layouts.md).
- Already shipped → keep as-is; a style restyles it without edits.
- Missing → write `layouts/<layout name>.html` per the slot contract and that
  layout's slot inventory. Start from the closest exemplar (same
  repeatable/media pattern). Extra layouts are harmless; delete unselected ones
  only if the user asks.

Preview each new layout by building a one-slide deck with placeholder fills
(see [generating-decks.md](generating-decks.md)) and `flow show file` it.

### Optional — the page-type multi-select

Only when the user wants to choose page types explicitly (or asks for a
template broader than one deck). Skipping it is the normal path.

Follow the `mcp-ui` skill's contract (`.mcp.html` + the inline JSON-RPC bridge):

- Write `<scratchpad>/decker-page-types.mcp.html` — a multi-select of the **17
  page types** from [layouts.md](layouts.md), one option per page type, its
  layout names shown as the option detail. Test IDs:
  `data-testid="mcp-ui-multiselect-<page type>"`. Pre-check the core six plus
  any the request implies.
- Present it: `flow show file <absolute path>.mcp.html` (exit 0 = shown), then
  **stop and wait** for the submission (text starting `MCP_UI_SUBMISSION ` with
  JSON like `{"selectedOptions": ["cover", "metrics", …]}`).
- Acknowledge with `MCP_UI_RECEIVED` and proceed with exactly those page types.

Outside FlowPad (no Vibe display), ask as a plain message listing the page types.

## 4. Write the manifest and index

Update `template.json` (two-section doc; don't add an `id` — the indexer mints
one via the `.flow/id` capsule):

```json
{
  "metadata": {
    "title": "<Template title>",
    "description": "<one line: design language + intended use>",
    "page_types": ["cover", "agenda", "…the selected ones"],
    "style": "<style slug>",
    "reveal_version": "5.2.0"
  },
  "data": {}
}
```

`style` records which style was applied, so a later session can re-apply or
re-style without guessing from the CSS. Unknown metadata keys ride through the
indexer into the entity's metadata, so this needs no schema change.

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
