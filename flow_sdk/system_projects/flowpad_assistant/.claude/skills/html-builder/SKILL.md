---
id: 624e65db-e277-486c-a82d-7369cd549dd8
name: html-builder
description: 'Build a static HTML page or app that looks designed, with no build step
  — no bundler, no transpiler, no node_modules. Use this whenever what you are writing
  is plain files a browser opens directly: an `.html` deliverable (a report, a chart,
  a mockup, a small multi-page site), an app or editor shipped inside an asset, a
  page served from a folder, or anything that must keep working when copied somewhere
  else. Reach for it the moment you are about to hand-roll a `<style>` block, and
  especially when a page you just wrote renders as bare unstyled text and needs to
  look intentional. Covers the CRAFT: modern CSS with no preprocessor, semantic structure,
  interactivity without a framework, the accessibility floor, and how to verify the
  result. It does NOT cover aesthetic direction — palette, typography and motion come
  from the `frontend-design` skill, which this one loads first. NOT for apps that
  need a dev server, a build, a database or auth (use web-app-builder), slide decks
  (use decker), or testing pages that already exist (use web-tester).'
allowed-tools:
- Read
- Write
- Edit
- Bash
- Glob
- Grep
---

# HTML Builder

Static does not mean plain. A page with no build step can be as considered as one
with a toolchain — the browser shipped the features, and what used to need Sass, a
bundler and a component library is now CSS and HTML. This skill is the craft half:
how to build it. The taste half belongs to `frontend-design`.

## First: load `frontend-design`

**Do this before writing any markup.** That skill decides palette, typefaces,
layout concept and the one signature element, through a two-pass process — plan,
then critique the plan against the brief before coding. This skill deliberately
repeats none of it. Building first and styling after produces a page whose
structure fights its design.

If you are working inside an existing product, the brief is usually "look like the
product" — see **Inside Flowpad** below, where the palette is already decided and
your job is layout, hierarchy and restraint.

## The contract

What you author is what ships. The folder IS the deliverable.

- No bundler, no transpiler, no `node_modules`, no install step.
- Vendor every dependency into the folder rather than linking a CDN, so the page
  still works offline and on a private network.
- Keep every path relative, so the folder works wherever it is copied or served from.
- One `index.html` per page, with shared CSS and JS as sibling files and images as
  image files. Flattening a site into one document and inlining images as `data:`
  URIs are workarounds for a problem you do not have — they cost you the browser
  cache and make the source unreadable.

## Structure: semantic elements first

Style the element, not a class, wherever an element exists for the job. `<main>`,
`<header>`, `<nav>`, `<section>`, `<article>`, `<ul>`, `<dl>`, `<table>`,
`<button>`, `<label>`, `<dialog>`, `<details>`. Classes are for variants, not for
things HTML already names.

This is the classless technique, and it pays three ways: the markup stays legible,
a forgotten class cannot leave an element unstyled, and you inherit keyboard and
screen-reader behaviour instead of rebuilding it. A `<div>` with a click handler is
a button you now have to make accessible yourself.

Author landmarks even in a small page — a screen reader navigates by them.

## CSS with no preprocessor

Everything below is Baseline across engines. You do not need a build step for any
of it, and reaching for one is how a static page stops being static.

- **Nesting** — the main reason people used Sass. Native now.
- **`@layer`** — declare cascade order once (`@layer reset, tokens, base,
  components, utilities;`) and stop fighting specificity.
- **Custom properties** — the design tokens from your plan live here, defined once
  on `:root` and referenced everywhere. Never repeat a hex value.
- **`clamp()`** for fluid type and spacing; **container queries** for components
  that must adapt to their container rather than the viewport; **`:has()`** for the
  parent selector; **`color-mix()`** for tints from one token; logical properties
  (`padding-inline`, `margin-block`) so the page survives translation;
  **`text-wrap: balance`** on headings.

Load `reference/css-baseline.md` for the feature list with the shapes to copy, the
`@layer` skeleton, and a starter that already has the quality floor in it.

**Specificity discipline** — a type selector and an element selector that both set
spacing will cancel each other in ways that are hard to see. Keep one owner per
property per element; `@layer` makes that enforceable rather than a matter of care.

## Interactivity without transpiling

- **Native ES modules.** `<script type="module">`, real `import`. No bundler.
- **Import maps** when you need bare specifiers or want to pin a version — Baseline,
  and they belong in the HTML rather than in a config file.
- **No framework.** If you are reaching for one, the page probably belongs to
  `web-app-builder` instead.
- **Prefer the platform**: `<dialog>` for modals, `popover` for menus and tooltips,
  `<details>` for disclosure, `<input type=...>` for validation, the URL for state
  worth sharing or reloading into. Each of these replaces a dependency.
- **Progressive enhancement.** Scroll-driven animations, view transitions and
  `field-sizing` degrade silently — use them freely, and the page is merely plainer
  where they are missing. Anchor positioning still wants a fallback.

## The quality floor

Build to it as you go; it is not a review step, and retrofitting it is far more
work than authoring it.

- **Visible keyboard focus.** Never remove an outline without replacing it. Style
  `:focus-visible`, and tab through the page before you call it done.
- **`prefers-reduced-motion`** honoured for every transition and animation.
- **Real labels** on every control — a placeholder is not a label.
- **Contrast** that holds in both colour schemes if the page supports both.
- **Responsive to a phone**, with no horizontal scroll.

## Verify — do not assert

You cannot tell whether a page looks right by reading its source. Open it, and
look. Then hand it to the **web-tester** skill, which sweeps for console errors,
uncaught exceptions, failed requests, broken links and accessibility findings, and
captures a full-page screenshot.

Check both colour schemes if the page supports both, and check it at phone width.

## Inside Flowpad

Flowpad serves static apps from a folder, so everything above applies unchanged.
Three additions:

- **Tokens.** `<link rel="stylesheet" href="/sdk/flowpad.css">` gives you the
  product's real palette, radii, font stack and dark theme. Use these tokens rather
  than inventing a palette: an app embedded in Flowpad should look like Flowpad,
  and `frontend-design`'s job here is layout and hierarchy, not colour.
- **Dark mode.** The sheet defines light on `:root` and dark under `.dark`. A page
  served in the Flowpad display receives `?theme=light|dark` — apply it to
  `<html>` before first paint so there is no flash.
- **Data.** `import * as sdk from '/sdk/flowpad-sdk.js'` reads and writes real
  entities. The rules that are easy to get wrong — always saving with the project
  scope, and that `watchQuery` resolves to an *unsubscribe function* rather than
  the rows — are written up once in `web-app-builder/template-flowpad/README.md`;
  read it before the first entity call rather than rediscovering them.

## Not this skill

| The request | Skill |
|---|---|
| Needs a dev server, a build, a database or auth | **web-app-builder** |
| A slide deck or presentation | **decker** |
| Testing or QA of pages that already exist | **web-tester** |
| Aesthetic direction — palette, type, motion | **frontend-design** (load it first) |

A static page that later grows a build step is a `web-app-builder` app; hand it
over rather than adding a bundler here.
