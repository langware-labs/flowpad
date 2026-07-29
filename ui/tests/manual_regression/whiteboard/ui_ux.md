---
id: 9d2a4c0e-1f8b-4e5a-9c11-550055005500
type: workflow
name: whiteboard_ui_ux
description: Whiteboard UI/UX U1-U4 — tree row icon, type filter, save debounce, paste image
tags: [whiteboard, ui]
---

# Whiteboard — UI / UX (U1–U4)

## Steps

### U1: Tree row + Palette icon
* Create a whiteboard `ui-u1-<random>`.
* Navigate to `${APP_URL}/dock/assets/list/whiteboard`.
* Wait for the asset list. Find a row containing `ui-u1-<random>`. Its row icon must be a Palette glyph (lucide-react Palette).

### U2: Type filter shows whiteboards only
* On the same page, locate `EntityTypeBar` (`[data-testid^="entity-type-"]` or similar).
* Click the "Whiteboard" option.
* Validate the rendered list contains the whiteboard from U1 AND does NOT contain non-whiteboard types (no rows for skills/agents/markdown).

### U3: Save debounce — five rapid updates coalesce into one write
* Open a whiteboard editor.
* NOTE: the save goes through axios, which in the browser uses XMLHttpRequest (NOT window.fetch). Hook `XMLHttpRequest.prototype.open` BEFORE the page loads to count `board.json` POST requests — this is load-independent (no reliance on file mtime timing). Excalidraw fires a finite burst of mount-phase writes, so snapshot the count AFTER that settles.
* Inject 5 separate canvas updates in rapid succession (each calls `__whiteboardOnChange`), spacing them well under the 750ms debounce window.
* Wait past the debounce, then read the write count again.
* The delta MUST equal 1 (a single debounced write coalescing all 5 updates). Two or more is a regression of the debounce.

### U4: Pasted image lives in `data.files`
* Open a whiteboard editor (smoke board).
* Inject an image element via `convertToExcalidrawElements` with a `fileId` referencing a base64 data URL added to `api.addFiles([{...}])`.
* Wait 1500ms.
* `cat <folder>/board.json` → `data.files` MUST contain an entry with the dataURL.
* Reload; image element still renders (no error boundary).

## Pass criteria

U1, U2, U3, and U4 must pass.

## Cleanup

* Remove created whiteboards.
