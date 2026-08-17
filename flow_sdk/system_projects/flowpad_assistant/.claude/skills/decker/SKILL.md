---
id: 63709c7b-005d-475f-b395-2460b0759587
name: decker
description: Build slide-deck templates and generate full presentation decks from
tags: ''
allowed-tools: ''
version: 2
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

## FIRST — ask for a style (when the design is undecided)

The skill ships **7 built-in styles** in `styles/` (see
[references/styles.md](references/styles.md)). A style is a complete design
system — palette, type, and composition. Do NOT invent a design language by
hand; pick one and, if asked, tune it after.

**Ask before anything else, with a one-click picker:**

```bash
python3 "<this skill's directory>/tools/make_style_picker.py" \
  -o "<scratchpad>/decker-style.mcp.html"
flow show file "<scratchpad>/decker-style.mcp.html"      # exit 0 = shown
```

Then **stop and wait.** The user's click arrives as a fresh prompt containing
`MCP_UI_SUBMISSION {"selectedStyle": "<slug>"}`. Acknowledge with
`MCP_UI_RECEIVED`, echo the chosen slug, and **continue straight through** to
building the deck — do not ask anything else. One click is the whole point.

**SKIP the picker entirely when the design is already decided:**

* the request names a style (*"make it swiss-signal"*, *"use the dark one"*) —
  match it against `styles/*/style.json` and proceed;
* the request names an existing template, or targets a template folder that
  already exists (`template.json` present) — that template already has a style;
* the task is maintenance: add a layout, edit a slide, re-word copy, rebuild.

Asking when the answer is already known is the failure mode here — it stalls a
non-interactive run waiting for a click that never comes.

**Outside FlowPad** (no Vibe display): list the styles from
`styles/*/style.json` as a plain message and ask.

## Repair an existing template before touching it

Templates bootstrapped before styles existed carry a **broken flex column**
(Reveal sets `display` inline, which beat the `.layout` rule, so content jammed
against the top edge). Before working on any pre-existing template:

```bash
grep -q "decker:structural-fix" "<template folder>/common/theme.css" || echo NEEDS_FIX
```

If it needs the fix, copy the `decker:structural-fix v1` block from this skill's
`template/common/theme.css` into the template's `common/theme.css`. It is
idempotent — the grep is the guard, so never add it twice.

## Stack contract (non-negotiable)

* **Reveal.js is headless.** It handles ONLY navigation, fullscreen,
  keyboard/touch, presenter view, overview, and transitions. Its theme CSS is
  never loaded — `common/tokens.css` + `common/theme.css` + `common/style.css`
  own every visual. If a deck looks wrong, fix those, never re-introduce a
  Reveal theme.

* **Three CSS layers, in this order** (the assembler concatenates them; see
  [references/styles.md](references/styles.md)):

  | file | role | comes from |
  |------|------|-----------|
  | `common/tokens.css` | the vocabulary: palette, type scale, font stacks, spacing | the style |
  | `common/theme.css` | the style-agnostic base + the structural fix | the scaffold |
  | `common/style.css` | the personality: what a card IS, rules, texture | the style |

  Applying a style = overwriting `tokens.css` + `style.css`. That is idempotent,
  so re-styling a template is always safe. `style.css` is optional — templates
  built before styles existed still assemble.

* **A generated deck is ONE self-contained HTML file.** Flowpad renders shown
  HTML in a sandboxed `srcDoc` iframe (`allow-scripts`, no `allow-same-origin`,
  no base URL): relative `./common/…` or `./media/…` references resolve to
  nothing, and `localStorage`/URL-hash state throws. Therefore the assembler
  inlines all CSS/JS (tokens, theme, Reveal runtime) and embeds media as base64
  data URIs, and Reveal initializes with `hash: false, history: false`. Do not
  "optimize" the deck into a folder of linked assets — it will render blank.

* **Layouts are isolated components** following the slot contract in
  [references/layouts.md](references/layouts.md). The layout taxonomy names
  there are canonical; narrative labels (problem, roadmap, team, …) are never
  layout names — they map onto layouts.

## Bootstrap a new template — copy as-is

The skill ships a complete, tested template scaffold in `template/` next to
this file (six exemplar layouts, tokens, vendored Reveal 5.2.0, the
`tools/build_deck.py` assembler).

1. **Copy the scaffold verbatim:**

   ```bash
   cp -R "<this skill's directory>/template/." "<project root>/assets/deck-templates/<template name>/"
   ```

   Do NOT hand-scaffold the folder or re-download Reveal. The scaffold is an
   internally consistent unit (slot contract ↔ theme classes ↔ assembler
   behavior all agree); hand-rolled copies drift and break assembly.

2. **Apply the chosen style** — two file copies, nothing else:

   ```bash
   S="<this skill's directory>/styles/<style slug>"
   T="<project root>/assets/deck-templates/<template name>/common"
   cp "$S/tokens.css" "$T/tokens.css"
   cp "$S/style.css"  "$T/style.css"
   ```

   Never hand-write a palette instead. If the user asked for a tweak (their
   brand red, a different face), apply the style first and then edit
   `tokens.css` — the style is the floor, not the ceiling.

3. **Layouts.** The scaffold already ships the core six (cover, agenda, content,
   media, metrics, closing) and that is the default — go with them and keep
   moving. Only when the user's request needs OTHER page types (a roadmap, the
   team, a comparison) generate those layouts per the slot contract, or run the
   optional page-type multi-select in
   [references/building-templates.md](references/building-templates.md).

4. **Write** **`template.json`** (title, description, `page_types`, `style`) and index:

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

**Testing the deck — use the** **`web-tester`** **skill.** When the user asks to test /
QA / validate / check the deck in a browser, route to the **web-tester** skill:
the assembled deck is a self-contained `.html`, so it sweeps it headlessly
(console/JS errors, failed requests, screenshot, basic a11y) and reports pass/fail,
keeping all debug artifacts in an isolated temp folder — not in this project.
Don't hand-roll Playwright checks here.

## Development guides

Read the matching reference before making that kind of change:

* **The style catalog, the 3-layer CSS contract, adding or tuning a style** →
  [references/styles.md](references/styles.md)

* **Bootstrapping a template, optional page-type selection, adding layouts** →
  [references/building-templates.md](references/building-templates.md)

* **Layout taxonomy, slot contract, per-layout slot inventories, design rules** →
  [references/layouts.md](references/layouts.md)

* **Generating decks: deck.json, slot filling, media, assembly** →
  [references/generating-decks.md](references/generating-decks.md)

* **Presenting: flow show, sandbox caveats, Reveal controls** →
  [references/presenting.md](references/presenting.md)
