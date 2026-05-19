---
id: 9d2a4c0e-1f8b-4e5a-9c11-770077007700
type: workflow
name: whiteboard_edge_cases
description: Whiteboard edge cases E1-E5 — empty save, close-without-save, crash recovery, large board, delete
tags: [whiteboard, edge]
---

# Whiteboard — Edge Cases (E1–E5)

## Steps

### E1: Empty save fires no PUT
* Open a fresh whiteboard editor (just created, never modified).
* Instrument fetch (see U3) to track `PUT board.json` count.
* Idle 3000ms — do NOT inject anything.
* `window.__pets.length` MUST equal 0. A PUT on idle is a regression (debounce/timer should not fire without an onChange).

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

### E5: Delete board removes folder + entity
* Create a whiteboard `e5-delete-<random>`. Note its id and folder path.
* DELETE `${API_URL}/api/v1/graph/whiteboard/<id>`.
* Expect HTTP 200.
* `ls <folder>` → directory MUST be gone.
* GET `${API_URL}/api/v1/graph/whiteboard/<id>` → expect HTTP 404 or empty data.
* GET `${API_URL}/api/v1/wiki/resolve?name=e5-delete-<random>` → expect `null`.

## Pass criteria

E1, E3, E4, E5 must pass. E2 is documentation-only (record observed behavior, no pass/fail gate).

## Cleanup

* Remove any leftover whiteboards.
