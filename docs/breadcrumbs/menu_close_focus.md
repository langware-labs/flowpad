---
title: A closing row menu gives focus back only when focus is still nowhere
tags: [breadcrumb.test.menu_close_focus.rules]
description: F2 on a file renamed its folder. The folder's context menu (Paste) closed after its exit
  animation, when focus was already on the file row, and its onCloseAutoFocus pulled focus back to the folder.
---
# A closing row menu gives focus back only when focus is still nowhere

> Ground truth. Proven by RCA on 2026-11-12. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.menu_close_focus.rules
sites:
  - rel_path: "ui/tests/manual_regression/assets/docs_tree_crud.md.ts"
    line: 32
    note: "FAILING at F2? a closing row menu must not pull focus back - read this tag's rules"
```

## Expected behavior

Right-click a folder → Paste, then focus a file row and press F2: the rename opens on the FILE
(`fs/rename/<root>/notes/a.md`), never on the folder the menu was on.

## Internals

| step | where |
| --- | --- |
| Row menu, its close handler | `ContextMenuContent onCloseAutoFocus` in `ui/src/components/browseable-tree/BrowseableTree.tsx` |
| The guard | `focusMovedOn(menu)` (same file): focus on another element, outside the menu → keep it |
| F2 on a focused row | `handleRowKeyDown` → `startRename` (same file): renames the row that has focus |

Radix calls `onCloseAutoFocus` when the menu's content unmounts, i.e. after its exit animation. A user (or
a test) can focus another row in that window; the default then moved focus back to the menu's row.

## Invariants

* A closing menu restores focus to its row only when focus is on the page (`body`) or inside the menu.
* Focus that moved on (another row, a rename box) stays where it is.

## Failure modes

* **F2 renames the folder** (`POST .../fs/rename/<root>/notes?new_name=renamed.md`). Proven 2026-11-12 with
  probes: `closeAutoFocus notes active=notes/a.md` then `focus notes`, 3 of 3 runs; with the guard 3 of 3 pass.
* The unit test `focusMovedOn` in `ui/tests/unit/browseable-tree-file-gestures.test.tsx` is a proxy: jsdom
  has no exit animation, so the late close only reproduces in the browser spec.
