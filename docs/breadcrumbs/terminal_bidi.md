---
title: Terminal RTL/bidi rendering contract
tags: [breadcrumb.test.terminal_bidi.rules]
description: A terminal row must be ONE bidi paragraph; xterm's injected display:inline-block breaks that and makes Hebrew read left-to-right. Two per-platform contracts, never both.
---
# Terminal RTL/bidi rendering contract

> Ground truth. Proven by RCA on 2026-08-03. Do not edit without the user's approval.

## Expected behavior

Sweeping a painted terminal row from **right to left** yields the sentence in the
order the PTY emitted it. That is the only definition of "RTL works" used here —
it is measurable (glyph screen-x via the Range API) and it is what the user sees.

Two failure shapes are distinct and must not be confused:

* **letters reversed inside each word** — the run was reordered *twice*.
* **each word correct, sentence running left-to-right** — the run was never
  treated as one run. This is the macOS bug fixed on 2026-08-03.

## Internals

RTL is reached by one of **two mutually exclusive contracts**, chosen by the
**PTY host platform**, not by the viewer:

| contract | PTY emits | who reorders | selected by |
|---|---|---|---|
| browser-bidi (macOS, Linux) | logical order | the browser | no `.xterm-rtl-grid` class |
| buffer-order (Windows) | visual order, pre-reversed | nobody — paint as-is | `.xterm-rtl-grid` class |

Windows PTY apps pre-reverse because conhost/Windows Terminal paint cells
strictly left-to-right; macOS terminals have real bidi engines, so apps there
leave the text logical. Applying both contracts, or the wrong one, double-reverses.

* `ui/src/components/terminal/interactive-terminal/terminalConfig.ts:49`
  `applyRtlGridContract(container)` — the gate. Adds `.xterm-rtl-grid` iff
  `navigator.platform` contains `win`. Client platform is the proxy for the PTY
  host platform: the desktop provider always spawns PTYs on the machine the UI
  runs on. Called from `InteractiveTerminal.tsx:832` and
  `SidecarShellTerminal.tsx:131`, immediately after `term.open(container)`.
* `ui/src/styles/xterm.css` — `.xterm-rtl-grid .xterm-rows > div, … span`
  sets `unicode-bidi: bidi-override; direction: ltr` (buffer-order contract).
  `unicode-bidi` is not inherited, so the rule must target the text-holding
  elements, not a container.
* `ui/src/styles/xterm.css` — `.xterm .xterm-rows span { display: inline !important }`
  (browser-bidi contract). See the invariant below.

### Why `!important` is load-bearing

`@xterm/xterm` injects, at runtime, into a `<style>` appended **inside the screen
element** (`DomRenderer.ts`, `_dimensionsStyleElement`):

```
<terminal-selector> .xterm-rows span { display: inline-block; height:100%; vertical-align:top }
```

The injected selector `.xterm-dom-renderer-owner-N .xterm-rows span` has the same
specificity (0,2,1) as an app rule `.xterm .xterm-rows span`, and sits later in
the document — so a plain override **silently loses**. Verified: without
`!important` the spec still fails.

### Why inline-block breaks bidi

`DomRendererRowFactory` splits a row into one `<span>` per style/letter-spacing
run. Hebrew's glyph advance differs from the ASCII cell advance, so the split
lands at every space — in practice **one span per word** (15–16 spans on a
7-word row). `display: inline-block` makes each an **atomic inline**: the bidi
algorithm sees a sequence of opaque neutral boxes, lays them out in the
paragraph direction (ltr), and reorders only the text *inside* each box. Hence
per-word-correct, sentence-LTR.

## Invariants

1. **A row is one bidi paragraph.** Nothing may make `.xterm-rows span` an
   atomic inline (`inline-block`, `float`, `contain`, `unicode-bidi: isolate`).
   Breaking this reintroduces the exact 2026-08-03 bug.
2. **Exactly one contract applies at a time.** `.xterm-rtl-grid` and
   browser-bidi are alternatives, never layered. `bidi-override` already pins
   glyphs to buffer order regardless of span boxing, which is why invariant 1's
   rule is a measured no-op on Windows.
3. **The grid is not negotiable.** Cell x-positions, cell-background height and
   row stacking must be byte-identical under either `display` value. Measured
   identical on 2026-08-03 (row 16px, bg span 16px, offset 0).
4. **Never assume a platform — measure.** The fix and the tests were both
   validated by glyph screen-x, not by eye and not by reasoning about CSS.

## Failure modes

* **Reproduction is font-sensitive.** The bug needs the row to split into
  multiple spans. On a host whose monospace font renders Hebrew at exactly the
  ASCII cell advance, the row collapses to one span and the whole sentence
  reorders correctly — a green test on a broken build.
* **jsdom and node cannot see this.** `tests/react` and `tests/unit` have no
  layout engine, no bidi, no glyph geometry, and will pass on a row the browser
  paints backwards. This class of bug requires a real browser.
* **Host-platform leakage in tests.** A spec that calls `applyRtlGridContract`
  and feeds a fixture for the *other* contract fails spuriously on Windows CI.
  Drive each contract explicitly; assert the gate's platform decision separately.
* **Chasing the wrong layer.** Markdown/chat surfaces have their own, unrelated
  RTL mechanism (`dir="auto"` per block, `ui/src/components/markdown-view.tsx`).
  A Hebrew complaint must first be pinned to terminal vs markdown — they share
  no code.

## Bound tests

* `ui/tests/browser_render/xterm-rtl.spec.ts` — real Chromium, real
  `@xterm/xterm`, real `ui/src/styles/xterm.css`, and a PTY row captured
  byte-for-byte from a live failing macOS session. Three cases: logical stream
  under browser-bidi, visual stream under buffer-order, and the platform gate.
  Run: `cd ui && npx playwright test --config tests/browser_render/playwright.config.ts`

<!-- flowpad:capsule identity
version: 1
data:
  id: fcb36e00-bcdd-468f-becc-4bf077bd755b
flowpad:endcapsule identity -->
