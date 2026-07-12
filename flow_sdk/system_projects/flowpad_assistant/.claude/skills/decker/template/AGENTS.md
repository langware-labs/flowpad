# Agent instructions

> **This deck template is managed by the FlowPad Assistant.**
> It was bootstrapped from the `decker` skill's template, and that skill
> remains the operating manual. **For ANY operation on this template —
> adding or editing layouts, re-skinning the tokens, generating a deck,
> presenting — invoke the `decker` skill first** and follow its references.
> They encode the contracts below; ad-hoc approaches drift from them.

## Stack (fixed by design — don't swap pieces)

Reveal.js 5.2.0 **headless** · design tokens (CSS custom properties) ·
stdlib-only Python assembler. Reveal handles ONLY navigation, fullscreen,
keyboard/touch, presenter view, overview, and transitions. It contributes
NO visual theme — every color, font, and spacing value comes from our
tokens.

## Contracts to preserve

- **Slot contract.** Each layout is one isolated HTML fragment with a single
  root `<section class="layout layout-<name>" data-layout="<name>"
  data-page-type="<type>">`. Every fillable region is an element carrying
  `data-slot="<name>"`. Omittable slots carry `data-optional` (the assembler
  drops them when unfilled). Repeatable regions are a `data-slot="items"`
  container holding one `<template data-item>` child. Media is
  `<figure data-slot="media" data-media-kind="…">`. Do not rename slots —
  the layout taxonomy and slot names are canonical.
- **Tokens-only styling.** Re-skinning edits ONLY `common/tokens.css`.
  Layouts and `common/theme.css` reference `var(--…)` — never hardcode a
  color, font, or raw pixel value that belongs in a token.
- **Headless Reveal.** `common/deck.js` initializes Reveal with
  `hash: false, history: false` (required — decks render inside a sandboxed
  `srcDoc` iframe with no same-origin, no base URL, no URL hash). Do not
  vendor or reintroduce Reveal theme CSS (`dist/theme/*`).
- **Self-contained assembly.** Decks are built ONLY via
  `tools/build_deck.py`, which inlines every CSS/JS/media asset (media as
  base64 data URIs). The output must have zero external references
  (`http(s)`, relative `./`, `localStorage`, URL hash).
- **Layout taxonomy names are canonical**: `cover-centered`, `agenda-list`,
  `content-single-column`, `media-full-bleed`, `metrics-grid`,
  `closing-centered`.
