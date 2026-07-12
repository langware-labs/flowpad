# Generating a deck

## 1. Pick a template

List candidates in `<project root>/assets/deck-templates/` (or record-search
`deck_template` entities). If none exists, bootstrap one first
([building-templates.md](building-templates.md)).

## 2. Map the narrative to layouts

Outline the story as slides; give each slide a **page type**, then its
**layout** from the template's `layouts/`. Narrative labels (problem, traction,
roadmap, team, …) map onto layouts via the table in
[layouts.md](layouts.md) — never invent a layout name per story beat. If the
template lacks a needed layout, add it to the template first (it stays
reusable) rather than inlining one-off markup in the deck.

## 3. Write `deck.json`

Output folder: `<project root>/assets/decks/<deck name>/` (kebab-case).
`deck.json` is the regenerable build record — the deck HTML is derived from
it, so edits go here, then rebuild:

```json
{
  "title": "Q3 Review",
  "template": "../../deck-templates/<template name>",
  "slides": [
    { "layout": "cover-centered",
      "slots": { "title": "Q3 Review", "subtitle": "October 2026" } },
    { "layout": "metrics-grid",
      "slots": { "title": "Traction",
                 "items": [
                   { "metric-value": "12k", "metric-label": "users", "metric-delta": "+40%" },
                   { "metric-value": "$1.2M", "metric-label": "ARR" } ] } },
    { "layout": "media-full-bleed",
      "slots": { "media": "media/common/hero.png", "caption": "The new dashboard" } }
  ]
}
```

Slot values: plain strings are HTML-escaped; `{"html": "…"}` inserts raw
markup (tables for `table-focus`, free content for `blank-canvas`). `items`
takes a list of per-item dicts. Media values are paths **relative to the
template folder** — put deck-specific media under the template's
`media/<layout name>/` (shared) or reference an absolute path.

## 4. Assemble

```bash
python3 "<template folder>/tools/build_deck.py" \
  "<deck folder>/deck.json" -o "<deck folder>/<deck name>.html"
```

The assembler fills slots, stamps repeatable items, removes unfilled
`data-optional` slots, embeds media as base64 data URIs, and inlines every
byte of CSS/JS — the output is one self-contained HTML file (the sandbox
render contract in SKILL.md requires this; never post-edit the deck to
reference external files). It fails loudly on unknown layouts/slots and
missing media.

### Media guardrails

- Prefer images; keep each asset under ~2 MB (the assembler warns above that —
  a data-URI-bloated deck reads slowly through the file channel).
- Charts/diagrams: render to PNG/SVG first (matplotlib, mermaid, …), then use
  `chart-focus`/`diagram-canvas` with the rendered file.
- Video is discouraged in v1: data-URI mp4s inflate the deck fast. If truly
  needed, keep clips tiny.

## 5. Show it

```bash
flow show file "<absolute path>/<deck name>.html"
```

See [presenting.md](presenting.md). To iterate: edit `deck.json` (or the
template), rebuild, and show again.
