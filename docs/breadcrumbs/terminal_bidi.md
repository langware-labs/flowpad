---
id: fcb36e00-bcdd-468f-becc-4bf077bd755b
title: Terminal RTL/bidi rendering contract
tags: [breadcrumb.test.terminal_bidi.rules]
description: The terminal RTL/bidi contract - one bidi paragraph per row, buffer-order chosen per CLI and not per platform, and stamped on BOTH container mount and vendor resolution
version: 5
---

# Terminal RTL/bidi rendering contract

> Ground truth. Proven by RCA on 2026-08-03 (one-bidi-paragraph rule),
> extended by RCA on 2026-08-04 (the contract is per CLI, not per platform)
> and by RCA on 2026-09-02 (the contract has two triggers, not one).
> Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.terminal_bidi.rules
sites:
  - rel_path: "ui/tests/browser_render/xterm-rtl.spec.ts"
    line: 168
    note: "FAILING? read this tag's rules before editing \u2014 do NOT relax the assertion or the CSS; a row must stay one bidi paragraph"
  - rel_path: "ui/tests/unit/terminal-headless-roundtrip.test.tsx"
    line: 407
    note: "FAILING? read this tag's rules before editing \u2014 the contract has TWO triggers (container mount AND vendor resolution); do not delete either stamp"
```

## Expected behavior

Sweeping a painted terminal row from **right to left** yields the sentence in the
order the PTY emitted it. That is the only definition of "RTL works" used here —
it is measurable (glyph screen-x via the Range API) and it is what the user sees.

Two failure shapes are distinct and must not be confused:

* **letters AND words both running left-to-right** — the row is painted in
  logical order. Either the run was reordered *twice* (browser bidi applied to
  a pre-reversed stream) or *not at all* (buffer-order applied to a logical
  stream); the two are visually identical, so the symptom alone does not tell
  you which contract is wrong — check what the app emits. The codex-on-Windows
  bug fixed on 2026-08-04 is the zero-reorder case.

* **each word correct, sentence running left-to-right** — the run was never
  treated as one run. This is the macOS bug fixed on 2026-08-03.

## Internals

RTL is reached by one of **two mutually exclusive contracts**, chosen by what
the PTY side emits — never by the viewer:

| contract     | PTY emits                  | who reorders         | selected by                |
| ------------ | -------------------------- | -------------------- | -------------------------- |
| browser-bidi | logical order              | the browser          | no `.xterm-rtl-grid` class |
| buffer-order | visual order, pre-reversed | nobody — paint as-is | `.xterm-rtl-grid` class    |

Which one an app needs is a function of **both the host platform and the CLI
vendor**, and the two are independent:

| <br />     | macOS / Linux          | Windows                     |
| ---------- | ---------------------- | --------------------------- |
| **claude** | logical → browser-bidi | pre-reversed → buffer-order |
| **codex**  | logical → browser-bidi | logical → browser-bidi      |

Claude Code pre-reverses **on Windows only**, because conhost/Windows Terminal
paint cells strictly left-to-right; macOS terminals have real bidi engines, so
it leaves the text logical there. codex never pre-reverses anywhere: its binary
links `unicode-width` but no bidi crate and has no `reorder_visual` path.
So two apps on the same Windows host want opposite contracts, and a gate that
reads only the platform must get one of them wrong. Applying both contracts, or
the wrong one, leaves the row in logical order.

* `ui/src/components/terminal/interactive-terminal/terminalConfig.ts:64`
  `applyRtlGridContract(container, vendor)` — the gate. Toggles
  `.xterm-rtl-grid` iff `navigator.platform` contains `win` **and** `vendor` is
  a proven pre-reverser (`claude` is the only member). `classList.toggle` and
  not `add`: the contract is re-applied when the vendor resolves and must clear
  a stale class. Client platform stays the proxy for the PTY host platform: the
  desktop provider always spawns PTYs on the machine the UI runs on.

* `InteractiveTerminal.tsx` — stamped from **two** places, and both are
  load-bearing (see invariant 6):

  * `:841`, inline after `term.open(container)` — covers the container's own
    mount. The container is conditionally rendered (`{!isHeadless && …}`), so
    this is the only writer that sees a container appear.
  * `:958`, a layout effect keyed on `[process?.worker_type]` — covers the
    vendor resolving after the terminal is already open, and CLEARS a stale
    class when it does (hence `classList.toggle`).

  Ordering is NOT guaranteed, and the open path is the one that can arrive
  late: the init effect ends in `waitForDimensions()` (`:908`), which opens
  synchronously only if the container already has a box and otherwise retries on
  a 10ms timer — so `term.open()` may run well after the vendor effect. The
  open-path read falls back to the `workerCliVendor()` default `claude` only
  while `process` is still null; a container that mounts later (the headless
  case below) reads a `worker_type` that has long since resolved. Either way a
  wrong default is self-correcting: `worker_type` resolving IS the vendor
  effect's dep change, so it re-runs and `classList.toggle` clears the class.
  The residual exposure is a brief wrong-contract paint for a NON-pre-reversing
  vendor on Windows while `process` loads — bounded, versus a permanently bare
  container.

* `SidecarShellTerminal.tsx:133` — passes `'unknown'`. A plain shell emits
  logical order on every platform.

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
   rule is a measured no-op under buffer-order.
3. **The contract belongs to the APP, not just the host.** Never gate it on
   `navigator.platform` alone. Buffer-order is opt-in per vendor and only for a
   vendor *proven* to pre-reverse — do not add one without a capture from that
   app on Windows showing pre-reversed bytes. Unknown apps get browser-bidi,
   because emitting logical order is the norm and pre-reversal the exception.
4. **The grid is not negotiable.** Cell x-positions, cell-background height and
   row stacking must be byte-identical under either `display` value. Measured
   identical on 2026-08-03 (row 16px, bg span 16px, offset 0).
5. **Never assume a platform or an app — measure.** Every fix and test here was
   validated by glyph screen-x on a real painted row, not by eye and not by
   reasoning about CSS. What an app emits is settled by capturing its PTY bytes
   (`pty.fork` + a real TUI), not by assuming it behaves like its neighbour.
6. **The contract has TWO independent triggers, and both must stamp.** A
   container can appear without the vendor changing, and the vendor can change
   without a container appearing. Wiring only one leaves the other case bare —
   which is exactly the 2026-09-02 bug: the inline stamp was deleted on
   2026-08-04 in favour of the vendor-keyed effect alone, and every session that
   mounted its container after `worker_type` had settled went unstamped from
   0.2.116 through 0.2.151. Deleting either call re-opens it.

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
  Drive each contract explicitly; assert the gate's decision separately, as a
  full platform × vendor matrix rather than a single boolean.

* **Deciding ONLY in the open path.** `worker_type` arrives with the subscribed
  process, so on a first render `term.open()` runs before it resolves and the
  open-path read falls back to the `workerCliVendor()` default, `claude`. That
  is why the vendor-keyed effect must exist — but it is NOT a reason to remove
  the open-path stamp, which is what happened on 2026-08-04. The open effect is
  keyed on `[sessionId, isHeadless]` and never re-runs on a vendor change; the
  vendor effect never re-runs on a mount. Each covers what the other cannot.

* **A container that mounts long after the vendor resolved.** The reachable
  form of the above, and the 2026-09-02 bug. `useProcessSurface` only ever calls
  `switchMode(WorkerMode.Interactive)` (`use-process-surface.ts:159`) — chat and
  vibe render the session's stream and need no transport of their own — so a
  session CREATED headless (`pty_mode: false`: `open-new-chat.ts`,
  `use-start-vibe-session.ts`, `start-wizard-process.ts`) mounts its container
  for the first time only when the user opens the Terminal view. Through the
  whole headless phase the vendor-keyed effect ran with no container to stamp,
  and `worker_type` never moves again — so that first container is bare and the
  session reads backwards until a new terminal is opened. A session started
  directly in the terminal is immune: its container exists on the first render
  while `worker_type` is still undefined, so the effect fires with a container
  present.

* **Assuming the round trip is reachable.** Because the switch is
  one-directional, `pty_mode` never returns to false for a live session:
  Terminal → Chat → Terminal does NOT unmount the container and reproduces
  nothing. A Windows run on 0.2.150 was spent confirming that. Reproduce from
  the headless side — start a chat/vibe session, let the turn finish (the
  switch is refused mid-turn, `awaitingUserInput`), then open its Terminal
  view.

* **A shipped build can lag the fix.** The 2026-08-03 macOS symptom reappeared
  on 2026-08-04 purely because the installed wheel (flowpad 0.2.115, spawning
  the PTY from `~/.local/share/uv/tools/flowpad/`) predated the CSS rule. Before
  root-causing a *recurrence*, grep the bundle the running backend actually
  serves — `site-packages/flow_sdk/server/static/assets/index-*.css` — for the
  rule; source being correct proves nothing about the app under test.

* **Chasing the wrong layer.** Markdown/chat surfaces have their own, unrelated
  RTL mechanism (`dir="auto"` per block, `ui/src/components/markdown-view.tsx`).
  A Hebrew complaint must first be pinned to terminal vs markdown — they share
  no code.

## Bound tests

* `ui/tests/browser_render/xterm-rtl.spec.ts` — real Chromium, real
  `@xterm/xterm`, real `ui/src/styles/xterm.css`, and PTY rows captured
  byte-for-byte from live sessions (Claude Code's per-word CHA row; codex's
  single-CUP contiguous row). Five cases: logical stream under browser-bidi,
  visual stream under buffer-order, codex on Windows, Claude Code on Windows,
  and the gate's full platform × vendor matrix. The last three run the REAL
  gate with `navigator.platform` supplied as a fixture, so they assert the same
  decision from macOS, Linux or a Windows runner.
  Run: `cd ui && npx playwright test --config tests/browser_render/playwright.config.ts`

* `ui/tests/unit/terminal-headless-roundtrip.test.tsx` — the LIFECYCLE half:
  renders the real `InteractiveTerminal` with `navigator.platform` = `Win32` and
  `worker_type` = `claude`, starts it headless (asserting nothing opened), then
  switches to the terminal and asserts the container that mounts carries
  `.xterm-rtl-grid`. It enters the way the product does, so it fails for the
  reason the product fails. jsdom has no bidi engine, so it can only assert the
  contract — what a bare container PAINTS is the spec above. The two tiers enter
  differently and are genuine independent coverage; neither alone asserts
  "backwards Hebrew after opening a chat session's terminal".
  Run: `cd ui && npx vitest run --project unit tests/unit/terminal-headless-roundtrip.test.tsx`
