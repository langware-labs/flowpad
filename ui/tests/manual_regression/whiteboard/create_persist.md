---
id: 9d2a4c0e-1f8b-4e5a-9c11-220022002200
type: workflow
name: whiteboard_create_persist
description: Whiteboard create + persist C1-C5 — quick-create, files on disk, frontmatter id, autosave, reload
tags: [whiteboard, create, persistence]
---

# Whiteboard — Create + Persist (C1–C5)

## Steps

### C1: Quick-create via UI
* Navigate to `${APP_URL}/`.
* On the landing page, locate the quick-create surface (MiniDesktop). It's a row of asset-type buttons or a "+" / "New" button — click the trigger to open the dropdown menu.
  * If no menu opens, fall back to navigating directly to `${APP_URL}/dock/assets/list/whiteboard` and using the asset-list page's "Create" / "+" affordance.
* Find a row labelled "Whiteboard" with a Palette icon.
* Click "Whiteboard". A name input dialog appears.
* Type `c1-board-<random-4-digits>` and submit.
* Wait up to 8s for the editor to open. URL should contain `/dock/assets/editor/whiteboard/`.
* Validate `[data-testid="whiteboard-editor"]` visible.

> Note: there is NO Cmd+K / Ctrl+K binding for QuickCreate in this codebase. Trigger via click only.

### C2: Files on disk
* From the editor URL, derive the folder path (after `/dock/assets/editor/whiteboard/`, prefix with `/`).
* Run `ls -la <folder>` via Bash.
* Validate `WHITE_BOARD.md` exists.
* Validate `board.json` either exists OR will be created on first save (the editor lazy-creates it).

### C3: Frontmatter id stamped (after index)
* Right after first save, WHITE_BOARD.md has the BEGIN/END mermaid block but NO frontmatter — the editor's autosave only splices the mermaid block; the frontmatter `id:` is stamped by the indexer (`whiteboard_gen_id`), not on save. Validate the BEGIN/END mermaid markers are present in the file body at this point.
* Trigger an index: POST `${API_URL}/api/v1/graph/compute_node/@local/fs-records/index?type=whiteboard`; wait ~3s.
* `cat <folder>/WHITE_BOARD.md` → frontmatter MUST now contain `id:` (a valid v5/v4 UUID). The BEGIN/END mermaid markers MUST survive the frontmatter stamp.

### C4: Draw + autosave + thumbnail
* In the editor tab, run via `browser_evaluate`:
  ```js
  const lib = window.__excalidrawLib;
  const api = window.__whiteboardApi;
  const els = lib.convertToExcalidrawElements([
    { type: 'rectangle', id: 'R1', x: 50, y: 50, width: 140, height: 60, label: { text: 'A' } },
    { type: 'rectangle', id: 'R2', x: 280, y: 50, width: 140, height: 60, label: { text: 'B' } },
    { type: 'arrow', x: 190, y: 80, width: 90, height: 0, points: [[0,0],[90,0]], start: { id: 'R1' }, end: { id: 'R2' } },
  ]);
  api.updateScene({ elements: els });
  window.__whiteboardOnChange(els, api.getAppState(), api.getFiles());
  ```
* Wait 1500ms past debounce.
* Validate `<folder>/board.json` mtime updated AND parses as JSON with `kind: "excalidraw"` and `data.elements.length >= 2`.
* Validate `<folder>/thumbnail.svg` exists (size > 200 bytes). Note: the thumbnail is the LAST write in the persist sequence (board.json → WHITE_BOARD.md → exportToSvg → thumbnail.svg), so poll for it for a few seconds after board.json appears rather than checking once.

### C5: Reload preserves content
* Navigate away (`${APP_URL}/`), then back to the editor URL.
* Wait up to 5s for the editor + canvas to remount.
* `window.__whiteboardApi.getSceneElements().length` >= 2 (the rectangles + arrow from C4).
* No React error boundary visible (the `appState.collaborators` Map regression would surface here).

## Pass criteria

C1–C5 all pass. C2's "board.json missing right after create" is acceptable (FINDING, not failure) — the editor creates it on first save.

## Cleanup

* `rm -rf <folder>` after the test completes.
