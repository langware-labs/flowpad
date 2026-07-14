---
id: 63709c7b-005d-475f-b395-2460b0759587
name: decker
description: Build slide-deck templates and generate full presentation decks from
  them — Reveal.js headless runtime + design-token CSS, each slide layout an
  isolated HTML component, assembled into a single self-contained deck HTML.
  Use this whenever the user wants to create, design, or generate a slide deck,
  presentation, slideshow, pitch deck, keynote, or slides — even if they don't
  literally say "deck", and even (especially) when they phrase it as "build me a
  presentation using flowpad assistant" — deck building belongs to THIS skill,
  not to flowpad-assistance and not to web-app-builder (decks are not web apps).
  Also use it to add layouts to an existing deck template, re-skin a template's
  design tokens, or regenerate/present a deck built from one. Templates are
  first-class `deck_template` entities under assets/deck-templates/; bootstrap
  means copying the bundled template as-is — never hand-scaffold the folder.
tags:
- deck
- slides
- presentation
- revealjs
- templates
allowed-tools:
- Bash
- Read
- Write
- Edit
- Glob
- Grep
---

# Decker — deck templates and deck generation

Two workflows, one design system:

1. **Build a deck template** — a reusable design language: one isolated HTML
   component per slide layout + shared design tokens. Stored at
   `<project root>/assets/deck-templates/<template name>/` and indexed as a
   first-class `deck_template` entity.
2. **Generate a deck** — pick a template, map the narrative onto layouts, fill
   slots, assemble. Output at `<project root>/assets/decks/<deck name>/` (a
   plain folder: the deck HTML + its regenerable `deck.json` build record).

`<project root>` is the session's current working directory. The user may name
another location, which overrides the default.

## Stack contract (non-negotiable)

- **Reveal.js is headless.** It handles ONLY navigation, fullscreen,
  keyboard/touch, presenter view, overview, and transitions. Its theme CSS is
  never loaded — `common/tokens.css` + `common/theme.css` own every visual.
  If a deck looks wrong, fix the tokens/theme, never re-introduce a Reveal theme.
- **A generated deck is ONE self-contained HTML file.** Flowpad renders shown
  HTML in a sandboxed `srcDoc` iframe (`allow-scripts`, no `allow-same-origin`,
  no base URL): relative `./common/…` or `./media/…` references resolve to
  nothing, and `localStorage`/URL-hash state throws. Therefore the assembler
  inlines all CSS/JS (tokens, theme, Reveal runtime) and embeds media as base64
  data URIs, and Reveal initializes with `hash: false, history: false`. Do not
  "optimize" the deck into a folder of linked assets — it will render blank.
- **Layouts are isolated components** following the slot contract in
  [references/layouts.md](references/layouts.md). The layout taxonomy names
  there are canonical; narrative labels (problem, roadmap, team, …) are never
  layout names — they map onto layouts.

## Bootstrap a new template — copy as-is

The skill ships a complete, tested template scaffold in `template/` next to
this file (six exemplar layouts, tokens, vendored Reveal 5.2.1, the
`tools/build_deck.py` assembler).

1. **Copy the scaffold verbatim:**

   ```bash
   cp -R "<this skill's directory>/template/." "<project root>/assets/deck-templates/<template name>/"
   ```

   Do NOT hand-scaffold the folder or re-download Reveal. The scaffold is an
   internally consistent unit (slot contract ↔ theme classes ↔ assembler
   behavior all agree); hand-rolled copies drift and break assembly.

2. **Ask which page types to support** via the MCP UI multi-select flow in
   [references/building-templates.md](references/building-templates.md), then
   generate ONLY the selected layouts that the scaffold doesn't already ship,
   following the slot contract.

3. **Write `template.json`** (title, description, `page_types`) and index:

   ```bash
   flow record index "<project root>"
   ```

   Index the **project root** (whose `assets/deck-templates/` is a direct
   child), NOT the template folder — the walker scans `<root>/assets/deck-templates/`,
   so indexing the template folder itself finds nothing.
   The template appears as a `deck_template` entity (verify with
   `flow schema info deck_template` / record search). Keep the copied
   `CLAUDE.md`/`AGENTS.md` in the template folder — they route every future
   agent session back through this skill.

If the target folder already contains a template (`template.json` +
`layouts/` present), skip bootstrap and go straight to the guides.

## Generate and present a deck

Follow [references/generating-decks.md](references/generating-decks.md):
narrative → page types → layouts → slot fills → `tools/build_deck.py` →
`assets/decks/<deck name>/<deck name>.html`.

**IMPORTANT — index and show the deck to the user.** A deck is a first-class
`deck` entity. Once the deck HTML exists, persist it and present it via the
entity so it opens in the bespoke **deck viewer** (full-bleed, fullscreen,
provenance link):

```bash
flow record index "<project root>"                          # persist the deck entity
flow show file "<project root>/assets/decks/<deck name>"    # the FOLDER, not the .html
```

Showing the deck **folder** resolves to the `deck` entity (via its `deck.json`
marker) → the deck viewer. Run `show` once (exit 0 = shown). See
[references/presenting.md](references/presenting.md) for the viewer + Reveal
controls. Outside FlowPad, print the deck `.html` path (it's a portable,
self-contained file) and suggest opening it in a browser.

**Testing the deck — use the `web-tester` skill.** When the user asks to test /
QA / validate / check the deck in a browser, route to the **web-tester** skill:
the assembled deck is a self-contained `.html`, so it sweeps it headlessly
(console/JS errors, failed requests, screenshot, basic a11y) and reports pass/fail,
keeping all debug artifacts in an isolated temp folder — not in this project.
Don't hand-roll Playwright checks here.

## Development guides

Read the matching reference before making that kind of change:

- **Bootstrapping a template, MCP UI layout selection, adding layouts** →
  [references/building-templates.md](references/building-templates.md)
- **Layout taxonomy, slot contract, per-layout slot inventories, design rules** →
  [references/layouts.md](references/layouts.md)
- **Generating decks: deck.json, slot filling, media, assembly** →
  [references/generating-decks.md](references/generating-decks.md)
- **Presenting: flow show, sandbox caveats, Reveal controls** →
  [references/presenting.md](references/presenting.md)
