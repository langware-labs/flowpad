# CSS you can use with no build step

> Ground rules (inline by design): taste comes from `frontend-design`, loaded
> before any of this. No CDN where the page may run offline. Verify by opening
> the page, then with `web-tester` — never by reading the source.

Everything here is Baseline across engines. Copy the shapes; do not install
anything to get them.

## Cascade order, declared once

```css
@layer reset, tokens, base, components, utilities;
```

Later layers win regardless of specificity, so a component rule never has to
out-specify a base rule. This is what removes `!important` and the
`.section p` / `p` spacing fights that are hard to see and harder to undo.

## Tokens

From the `frontend-design` plan — 4–6 named colours, the type roles, a spacing
step. Defined once, referenced everywhere; a repeated hex value is a bug.

```css
@layer tokens {
  :root {
    --ink: #16161d;
    --paper: #fbfaf7;
    --accent: #c2410c;
    --edge: color-mix(in srgb, var(--ink) 14%, transparent);

    --font-display: "…", Georgia, serif;
    --font-body: "…", system-ui, sans-serif;

    --step: 0.75rem;
    --radius: 0.5rem;
  }
}
```

`color-mix()` derives tints and borders from a token instead of adding near-
duplicate colours to the palette.

## Nesting

Native. No preprocessor.

```css
.card {
  padding: var(--step);
  & > h3 { margin-block: 0 calc(var(--step) / 2); }
  &:hover { border-color: var(--accent); }
  @media (width < 40rem) { padding: calc(var(--step) / 2); }
}
```

## Fluid type and space

`clamp(min, preferred, max)` replaces breakpoint stacks for anything that scales
smoothly.

```css
h1 { font-size: clamp(1.75rem, 1.2rem + 2.5vw, 3rem); text-wrap: balance; }
```

`text-wrap: balance` on headings; `text-wrap: pretty` on body copy to kill orphans.

## Container queries

A component that adapts to *its container*, not the viewport — the reason a card
can be reused in a sidebar and a full-width grid without variants.

```css
.pane { container-type: inline-size; }
@container (width > 30rem) {
  .card { grid-template-columns: 8rem 1fr; }
}
```

## `:has()`

The parent selector. Style a container by what it contains, and drop the class
you would otherwise toggle from JS.

```css
label:has(input:invalid) { color: var(--danger); }
.row:has(> :nth-child(3)) { grid-template-columns: repeat(3, 1fr); }
```

## Logical properties

`padding-inline`, `margin-block`, `border-inline-start`, `inset-inline`. The page
survives a right-to-left locale without a second stylesheet.

## Colour schemes

```css
:root { color-scheme: light dark; }
```

Then either `light-dark(#fff, #111)` per property, or — when a host tells you the
theme — a `.dark` block that redefines the tokens only. Redefining tokens beats
overriding rules: one block, and every consumer follows.

## The quality floor, as CSS

```css
@layer base {
  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }
  img, svg, video { max-width: 100%; height: auto; }
}
```

Never delete an outline without replacing it. Tab through the page before you
call it finished.

## Progressive, degrades on its own

Use freely — where unsupported the page is plainer, not broken.

- **Scroll-driven animations** — `animation-timeline: view()`, no observer, no JS.
- **View transitions** — `@view-transition { navigation: auto; }` for cross-document.
- **`field-sizing: content`** — inputs that grow with their value.
- **`@starting-style`** — entry animations for elements that just appeared.

Needs a fallback: **anchor positioning** (`anchor-name` / `position-anchor`) —
check support and provide a static position behind it.

## Interactivity: prefer the platform

| Instead of a library | Use |
|---|---|
| A modal component | `<dialog>` + `showModal()` |
| A dropdown or tooltip | `popover` attribute |
| An accordion | `<details>` / `<summary>` |
| Form validation | `type`, `required`, `pattern`, `:user-invalid` |
| A client router / state store | the URL, read on load |
| A bundler for dependencies | `<script type="importmap">` |

```html
<script type="importmap">
  { "imports": { "lib": "./vendor/lib.js" } }
</script>
<script type="module">
  import { thing } from 'lib';
</script>
```

## Starter

A page with the floor already in it — layers declared, focus visible, motion
respected, scheme-aware. Fill the tokens from the design plan.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>…</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header><h1>…</h1></header>
  <main>…</main>
  <script type="module" src="app.js"></script>
</body>
</html>
```

Keep CSS in `styles.css` rather than a `<style>` block once it outgrows a screen —
it is easier to read, and the browser caches it across pages.
