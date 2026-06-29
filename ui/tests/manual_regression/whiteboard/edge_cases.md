---
id: 9d2a4c0e-1f8b-4e5a-9c11-770077007700
type: workflow
name: whiteboard_edge_cases
description: Whiteboard edge cases E1-E5 — empty save, close-without-save, crash recovery, large board, delete
tags: [whiteboard, edge]
---

# Whiteboard — Edge Cases (E1–E5)

## Steps

### E1: Idle does not loop the debounced save
* Open a fresh whiteboard editor (just created, never modified).
* NOTE: the editor saves via fsManager.writeFile over axios/XHR (NOT window.fetch), so a `window.fetch` hook will not see saves — use the `board.json` mtime as the signal. ALSO NOTE: Excalidraw fires onChange a couple of times during initialization (scene + appState settling), so `board.json` sees a small, finite burst of mount writes. That burst is framework behavior, not a debounce regression.
* Wait for the `board.json` mtime to go QUIESCENT (unchanged across a ~2s quiet window) to establish the steady-state baseline.
* Idle 3000ms — do NOT inject anything.
* The mtime MUST be unchanged from the quiescent baseline. A debounce that keeps re-firing on idle (timer loop / re-arming without a new onChange) is the regression this guards against.

### E2: Close without save
* Open a whiteboard, inject 1 element via API + onChange.
* WITHIN 200ms (BEFORE the 750ms debounce fires), navigate away to `${APP_URL}/`.
* Wait 2000ms.
* `<folder>/board.json` content: assert behavior. Document whatever actually happens:
  * If the editor's unmount cleanup flushed the pending save → board.json contains the element.
  * If unmount cancelled the pending save → board.json still empty.
  * Either is acceptable; record which behavior the implementation has.

### E3: Crash-mid-edit recovery
* Open a whiteboard, inject 2 elements + onChange. Wait 1000ms past debounce (so save completes).
* Hard-refresh the page (full reload via `location.reload()`).
* Validate the canvas remounts with both elements present.
* No `.tmp` / `.swp` orphan files in the folder (`ls -la <folder>`).

### E4: Large board performance
* Open a fresh whiteboard. Generate 100 rectangle elements via:
  ```js
  const lib = window.__excalidrawLib;
  const api = window.__whiteboardApi;
  const els = lib.convertToExcalidrawElements(
    Array.from({length:100}, (_,i) => ({ type:'rectangle', x:(i%10)*60, y:Math.floor(i/10)*60, width:50, height:50, label:{text:`N${i}`} }))
  );
  api.updateScene({ elements: els });
  window.__whiteboardOnChange(els, api.getAppState(), api.getFiles());
  ```
* Wait 2000ms past debounce.
* Validate `<folder>/board.json` contains all 100 elements (+ their text labels, ~200 elements total).
* WHITE_BOARD.md mermaid block is still emitted (may be large; ensure it ends with `<!-- END whiteboard:auto -->`).
* Browser performance: page is responsive (no long-task warnings > 200ms in console).

### E5: Delete board removes entity (folder kept on disk by design)
* Create a whiteboard `e5-delete-<random>`. Note its id and folder path.
* DELETE `${API_URL}/api/v1/graph/whiteboard/<id>`.
* Expect HTTP 200.
* GET `${API_URL}/api/v1/graph/whiteboard/<id>` → expect HTTP 404 or empty data (the entity is gone from the graph).
* NOTE: DELETE keeps the on-disk folder by default — assert the ENTITY is gone, NOT the folder. `ls <folder>` still showing the directory is expected, not a failure.

## Pass criteria

E1, E3, E4, E5 must pass. E2 is documentation-only (record observed behavior, no pass/fail gate).

## Cleanup

* Remove any leftover whiteboards.
