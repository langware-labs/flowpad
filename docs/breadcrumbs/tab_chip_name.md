---
title: A tab chip is named at every density
tags: [breadcrumb.test.tab_chip_name.rules]
description: On a crowded strip TabStrip renders icon-only chips with no title text; readers of tab names
  (specs, screen readers) read the chip's data-tab-title / aria-label, never its text span.
---
# A tab chip is named at every density

> Ground truth. Proven by RCA on 2026-11-12. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.tab_chip_name.rules
sites:
  - rel_path: "ui/tests/manual_regression/terminal/shell_tab_title_and_switch.md.ts"
    line: 79
    note: "FAILING on a tab name? read it from data-tab-title, never the chip text - read this tag's rules"
  - rel_path: "ui/tests/manual_regression/terminal/terminal_tab_rename.md.ts"
    line: 5
    note: "FAILING on a tab name? read it from data-tab-title, never the chip text - read this tag's rules"
  - rel_path: "ui/tests/manual_regression/chat/new_sessions_always_opened_with_session_1_header.md.ts"
    line: 33
    note: "FAILING on a tab name? read it from data-tab-title, never the chip text - read this tag's rules"
  - rel_path: "ui/tests/unit/tab-strip-close-freeze.test.tsx"
    line: 379
    note: "FAILING on a tab name? read it from data-tab-title, never the chip text - read this tag's rules"
```

## Expected behavior

Every chip of the tab strip carries its title, whatever its width: `data-tab-title` always, and `aria-label`
when the chip is icon-only. Readers of tab names use those.

## Internals

| step | where |
| --- | --- |
| Density: `icon` when the per-chip width falls under `ICON_ONLY_BELOW_PX` | `TabStrip` (`ui/src/components/tabs/TabStrip.tsx`, `setDensity`) |
| An icon-only chip renders no `span.font-medium` title | `renderChip`, `iconOnly` (same file) |
| The chip's name | `data-tab-title={displayTitle}`, `aria-label` when `iconOnly` (same file) |
| Shared spec reader | `readTabLabel` (`ui/tests/manual_regression/terminal/helpers.ts`) |

## Invariants

* Never read a tab name from the chip's text: earlier specs leave tabs open on the shared instance, the strip
  crowds, and every name reads as `''`.
* Double-click rename works on the title span only: a spec that renames by double-click starts from an
  uncrowded strip (`close-all-tabs-button`).

## Failure modes

* `names` empty / `Tab "x" not found` / `toContainText(/Tab \d+/)` received `''` on a strip of ~20 chips.
  Proven 2026-11-12: the unit test fails without `data-tab-title` (all `null`) and passes with it; the three
  specs pass on qw-71 with the readers changed.
