# Layout taxonomy and slot contract

The names below are canonical across every template built by this skill. A
template implements a subset; a deck references layouts by these names.

## Page types → layouts

**v1 core: 17 semantic page types, 21 required layouts.** "Required" means a
full template implements them; a user-selected template implements only the
selected page types (each selected page type brings its required layouts).

| Page type       | Required layouts                              | Optional layouts |
|-----------------|-----------------------------------------------|------------------|
| cover           | cover-centered                                | cover-split |
| agenda          | agenda-list                                   | agenda-grid |
| section-divider | section-divider-centered                      | section-divider-image |
| content         | content-single-column, content-two-column     | content-three-column |
| statement       | statement-centered                            | statement-with-proof |
| media           | media-full-bleed, text-media                  | media-text, media-grid |
| comparison      | comparison-two-column                         | comparison-table |
| process         | process-horizontal                            | process-vertical |
| timeline        | timeline-horizontal                           | timeline-vertical |
| metrics         | metric-hero, metrics-grid                     | — |
| data            | chart-focus, table-focus                      | chart-with-insight |
| diagram         | diagram-canvas                                | — |
| quote           | quote-feature                                 | quote-portrait |
| people          | people-grid                                   | profile-feature |
| summary         | summary-takeaways                             | — |
| closing         | closing-centered                              | closing-cta, closing-qa |
| blank           | blank-canvas                                  | — |

## Narrative labels are NOT layouts

Slide intents like *problem*, *solution*, *market-size*, *business-model*,
*case-study*, *traction*, *roadmap*, *team* never become layout names — they
would multiply the taxonomy per story instead of reusing it. Map them:

| Narrative intent        | Use layout(s) |
|-------------------------|---------------|
| problem / solution      | statement-centered or content-single-column |
| market-size             | metric-hero or chart-focus |
| business-model          | content-two-column or diagram-canvas |
| case-study              | text-media or content-two-column |
| traction                | metrics-grid |
| roadmap                 | timeline-horizontal |
| team                    | people-grid |

## Slot contract

Each layout is one isolated HTML fragment file at `layouts/<layout name>.html`:

```html
<!-- layouts/metric-hero.html -->
<section class="layout layout-metric-hero" data-layout="metric-hero" data-page-type="metrics">
  <header class="kicker" data-slot="kicker" data-optional>Kicker</header>
  <h2 data-slot="title">Big number, one message</h2>
  <div class="metric-value" data-slot="metric-value">42%</div>
  <p data-slot="metric-label">of something meaningful</p>
  <footer data-slot="footnote" data-optional>Source: …</footer>
</section>
```

Rules (the assembler `tools/build_deck.py` depends on each of these):

1. **One root `<section>`** per file, classed `layout layout-<name>`, carrying
   `data-layout="<name>"` and `data-page-type="<page type>"`. It becomes the
   Reveal slide verbatim.
2. **Every fillable region is `data-slot="<slot name>"`.** The assembler
   replaces the element's inner content with the fill value (plain text is
   escaped; `{"html": …}` values are inserted raw).
3. **`data-optional`** marks slots the assembler removes entirely when the
   deck doesn't fill them. Non-optional slots keep their placeholder content
   when unfilled — so authoring placeholders must look presentable.
4. **Repeatables** (agenda rows, metric tiles, people cards…): a container
   `data-slot="items"` holding one `<template data-item>` child with the
   per-item markup (its own inner `data-slot` elements). The assembler stamps
   one copy per item.
5. **Media slots**: `<figure data-slot="media" data-media-kind="image">`
   (or `video`). The assembler replaces the content with an `<img>`/`<video>`
   whose `src` is a base64 data URI — never a file path (see the sandbox rule
   in SKILL.md).
6. **Styling comes from tokens and theme classes.** Use `common/theme.css`
   classes (`.kicker`, `.card`, `.metric-value`, `.grid`) and `var(--…)` tokens.
   Layout-specific CSS is allowed as one `<style>` block at the top of the
   fragment, scoped under `.layout-<name>` — no hardcoded colors/sizes that
   bypass the token system, or styles stop being able to re-skin the layout.
   Keep that block **structural** (what goes where); leave what things *look
   like* to the style. A style must be able to restyle your layout without
   editing it — see [styles.md](styles.md).

## Per-layout slot inventories

Required slots are listed plain; optional slots are marked *(opt)*. Repeatable
containers show their item slots in braces.

**cover-centered** — title, subtitle *(opt)*, presenter *(opt)*, date *(opt)*
**cover-split** — title, subtitle *(opt)*, media, presenter *(opt)*
**agenda-list** — title, items {label, detail *(opt)*}
**agenda-grid** — title, items {label, detail *(opt)*}
**section-divider-centered** — number *(opt)*, title, subtitle *(opt)*
**section-divider-image** — number *(opt)*, title, media
**content-single-column** — kicker *(opt)*, title, body
**content-two-column** — kicker *(opt)*, title, body-left, body-right
**content-three-column** — title, items {heading, body}
**statement-centered** — statement, attribution *(opt)*
**statement-with-proof** — statement, items {metric-value, metric-label}
**media-full-bleed** — media, caption *(opt)*
**text-media** — kicker *(opt)*, title, body, media  (text left, media right)
**media-text** — kicker *(opt)*, title, body, media  (media left, text right)
**media-grid** — title, items {media, caption *(opt)*}
**comparison-two-column** — title, heading-left, body-left, heading-right, body-right
**comparison-table** — title, items {label, left, right}
**process-horizontal** — title, items {step, detail *(opt)*}
**process-vertical** — title, items {step, detail *(opt)*}
**timeline-horizontal** — title, items {date, label, detail *(opt)*}
**timeline-vertical** — title, items {date, label, detail *(opt)*}
**metric-hero** — kicker *(opt)*, title, metric-value, metric-label, footnote *(opt)*
**metrics-grid** — title, items {metric-value, metric-label, metric-delta *(opt)*}
**chart-focus** — title, media, insight *(opt)*  (chart rendered to an image)
**chart-with-insight** — title, media, insight
**table-focus** — title, body (an HTML table via `{"html": …}`), footnote *(opt)*
**diagram-canvas** — title *(opt)*, media  (diagram rendered to an image/SVG)
**quote-feature** — quote, attribution
**quote-portrait** — quote, attribution, media
**people-grid** — title, items {media *(opt)*, name, role, detail *(opt)*}
**profile-feature** — title *(opt)*, media, name, role, body
**summary-takeaways** — title, items {label, detail *(opt)*}
**closing-centered** — title, subtitle *(opt)*, contact *(opt)*
**closing-cta** — title, cta, contact *(opt)*
**closing-qa** — title, subtitle *(opt)*
**blank-canvas** — body (free HTML via `{"html": …}`)

When generating a layout the scaffold doesn't ship, copy the structure of the
closest exemplar (same repeatable/media pattern), keep the inventory above as
the slot set, and preview it by building a one-slide deck.

## Design rules

- Slides are authored for a **1280×720 (16:9)** canvas; keep content inside
  the safe-area padding token. Minimum readable sizes: body ≥ `--fs-body`,
  captions ≥ `--fs-caption` — if content doesn't fit, split the slide, don't
  shrink the type.
- One idea per slide; the layout taxonomy exists so density lives in layouts,
  not in font-size hacks.
- **Re-skinning a template = applying a style** (`common/tokens.css` +
  `common/style.css`, both overwritten from `styles/<slug>/`). See
  [styles.md](styles.md). If a re-skin needs to touch a layout file, the layout
  has hardcoded design — fix that.
- Content sits on the **optical centre** of the 720px canvas; `theme.css`'s
  `decker:structural-fix` block handles that for every layout. A layout that
  genuinely wants top alignment overrides `justify-content` under its own
  `.layout-<name>` block. Roughly 40% canvas fill with generous margins is
  correct — a slide is not a form to be filled.
