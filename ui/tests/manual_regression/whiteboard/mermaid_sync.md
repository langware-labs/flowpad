---
id: 9d2a4c0e-1f8b-4e5a-9c11-330033003300
type: workflow
name: whiteboard_mermaid_sync
description: Whiteboard mermaid auto-sync M1-M5 — block written, human prose preserved, degenerate boards, decision diamond, mermaid import
tags: [whiteboard, mermaid]
---

# Whiteboard — Mermaid Auto-sync (M1–M5)

## Prerequisites

* A whiteboard exists with the dev-hooks (`window.__excalidrawLib`, `window.__whiteboardApi`, `window.__whiteboardOnChange`) populated. Create one via C1 if needed.

## Steps

### M1: Mermaid block written
* Inject 2 rectangles + 1 arrow with text labels (same as C4).
* Wait 1500ms.
* `cat <folder>/WHITE_BOARD.md` → MUST contain `<!-- BEGIN whiteboard:auto -->` followed by ` ```mermaid` followed by `flowchart TD` followed by node tokens for the labels followed by `<!-- END whiteboard:auto -->`.

### M2: Human content preserved outside markers
* Edit WHITE_BOARD.md via Bash (heredoc) to insert prose ABOVE the BEGIN marker and BELOW the END marker, plus a `[[wiki link]]` in the post-content. Keep stale content INSIDE markers.
* Trigger another save (inject one more element + call `__whiteboardOnChange`). Wait 1500ms.
* `cat <folder>/WHITE_BOARD.md` → prose above + below MUST survive. `[[wiki link]]` MUST be intact. The content inside the BEGIN/END block MUST be replaced (no longer stale).

### M3: Degenerate (freehand-only) board still emits valid mermaid
* Create a NEW whiteboard for this case (POST + navigate).
* Inject only freedraw strokes via `convertToExcalidrawElements([{ type:'freedraw', x:0, y:0, points:[[0,0],[50,20],[100,30]] }])`.
* Wait 1500ms.
* WHITE_BOARD.md mermaid block must contain `flowchart TD` AND a `%% loose elements:` comment (with `freedraw` mentioned). The fenced block must not be empty (renderers fail on empty mermaid).

### M4: Decision diamond
* On the M3 board (or a new one), inject `{ type: 'diamond', x: 50, y: 200, width: 100, height: 80, label: { text: 'OK?' } }`.
* Wait 1500ms.
* WHITE_BOARD.md mermaid block must contain `N<n>{{OK?}}` (mermaid v10+ double-curly diamond syntax). The single-curly `N<n>{OK?}` form is also acceptable for backward compat.

### M5: Mermaid import dialog
* In the editor, click `[data-testid="open-import-mermaid"]`.
* Wait for the dialog. Click into `[data-testid="mermaid-import-textarea"]` and type:
  ```
  flowchart TD
    X[Foo] --> Y[Bar]
  ```
* Click `[data-testid="confirm-import-mermaid"]`.
* Wait 1500ms past debounce.
* Validate `window.__whiteboardApi.getSceneElements().length` includes new rectangles labelled "Foo" and "Bar".
* WHITE_BOARD.md mermaid block now reflects the imported elements (contains `Foo` and `Bar` tokens).

## Pass criteria

All five sub-scenarios pass.

## Cleanup

* Remove all whiteboards created during this test via `rm -rf`.
