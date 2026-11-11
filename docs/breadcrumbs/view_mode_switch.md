---
id: 5285ddf4-15dc-40aa-a8b0-c62deacbe564
title: Magic-line view-mode switch off a session page
tags: [breadcrumb.test.view_mode_switch.rules]
description: A view mode lives on a session tab; "switch to vibe/terminal mode" off one saves the mode and opens the last chat in it — never a silent no-op.
---
# Magic-line view-mode switch off a session page

> Ground truth. Proven by RCA on 2026-11-11 (QA i19; cause first shown in i18). Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.view_mode_switch.rules
sites:
  - rel_path: "ui/tests/unit/ui-actions.test.tsx"
    line: 23
    note: "FAILING? read this tag's rules before changing switchMode or DockPointer's view-mode drop"
```

## Expected behavior

`action:view-mode-vibe` / `action:view-mode-advanced` (navigation sentences 178 and 179):
* **On a session tab:** re-point that tab with `?viewMode=`.
* **Anywhere else:** `setViewMode(mode)` (the mode sessions open in from now on), then open the project's last chat (`lastChatQuery` + `mostRecentProcess`) in that mode.

## Internals

* `ui/src/navigation/ui-actions.ts` `switchMode`.
* `ui/src/navigation/DockPointer.ts` constructor + `carriesViewMode`: drops `?viewMode` off session docks.
* `ui/src/contexts/view-mode-context.tsx` `setViewMode`, `UNSTATED_VIEW_MODE`.

## Invariants

* The switch never re-points a non-session dock at a mode. That is the same URL, so `commitBrowserNavigation` does nothing while the action still reports success.

## Failure modes

* With no chat in the project, only the mode is saved: nothing navigates.
