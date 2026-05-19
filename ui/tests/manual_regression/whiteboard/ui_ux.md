---
id: 9d2a4c0e-1f8b-4e5a-9c11-550055005500
type: workflow
name: whiteboard_ui_ux
description: Whiteboard UI/UX U1-U5 — tree row icon, type filter, save debounce, paste image, read-only thumbnail
tags: [whiteboard, ui]
---

# Whiteboard — UI / UX (U1–U5)

## Steps

### U1: Tree row + Palette icon
* Create a whiteboard `ui-u1-<random>`.
* Navigate to `${APP_URL}/dock/assets/list/whiteboard`.
* Wait for the asset list. Find a row containing `ui-u1-<random>`. Its row icon must be a Palette glyph (lucide-react Palette).

### U2: Type filter shows whiteboards only
* On the same page, locate `EntityTypeBar` (`[data-testid^="entity-type-"]` or similar).
* Click the "Whiteboard" option.
* Validate the rendered list contains the whiteboard from U1 AND does NOT contain non-whiteboard types (no rows for skills/agents/markdown).

### U3: Save debounce — exactly one PUT after 750ms
* Open a whiteboard editor. In `browser_evaluate`, instrument fetch:
  ```js
  window.__pets = [];
  const orig = window.fetch;
  window.fetch = function(...args) {
    if (String(args[0]).includes('board.json') && args[1]?.method === 'PUT') window.__pets.push(Date.now());
    return orig.apply(this, args);
  };
  ```
* Inject 5 separate canvas updates in rapid succession (each calls `__whiteboardOnChange`).
* Wait 1500ms past last update.
* `window.__pets.length` MUST equal 1 (single debounced PUT). Two or more PUTs is a regression of the debounce.

### U4: Pasted image lives in `data.files`
* Open a whiteboard editor (smoke board).
* Inject an image element via `convertToExcalidrawElements` with a `fileId` referencing a base64 data URL added to `api.addFiles([{...}])`. (If the API doesn't expose `addFiles` cleanly, mark this scenario `skip` with reason `clipboard-api-not-driveable-via-mcp`.)
* Wait 1500ms.
* `cat <folder>/board.json` → `data.files` MUST contain an entry with the dataURL.
* Reload; image element still renders (no error boundary).

### U5: Read-only thumbnail / view-only mode
* Find a UI surface that renders a whiteboard in `viewModeEnabled` (asset preview, hover card, or `![[name]]` transclusion if present).
* Validate the rendered Excalidraw container does NOT show the drawing toolbar (selection-tool buttons absent), only the canvas content.
* If no such surface exists in v1, mark `skip` with reason `view-only-preview-not-yet-implemented`.

## Pass criteria

U1, U2, U3 must pass.  
U4: pass OR `skip:clipboard-api`.  
U5: pass OR `skip:view-only-preview-not-yet-implemented`.

## Cleanup

* Remove created whiteboards.
