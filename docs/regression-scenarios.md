# Manual Regression Scenarios

Scenarios to run before shipping changes that touch the project collaboration
space, the Milkdown editor, or the asset routing layer. Each scenario lists
the precondition, steps, and expected result. Steps are written so a tester
can execute them without prior context.

---

## A. Selection toolbar (Milkdown)

The selection toolbar is a floating popup that appears above any non-empty
text selection inside an editable Milkdown surface. It reuses the static
toolbar's first cluster: **Bold, Italic, Inline code, Link**.

### A1 — Toolbar appears on selection

1. Open any markdown doc in `editor` mode (e.g. `Properties` icon → switch
   to `Editor`).
2. Drag-select 3+ characters in a paragraph.
3. **Expected:** a small toolbar appears centred above the selection with 4
   buttons (Bold, Italic, Inline code, Link). `data-testid="selection-toolbar"`.

### A2 — Bold from selection toolbar formats the text

1. Select a word in the editor.
2. Click **Bold** in the popup.
3. **Expected:** the word becomes bold (`<strong>` in the rendered HTML);
   the popup remains visible while selection persists.

### A3 — Toolbar disappears on collapse

1. With a selection active and the popup visible, click anywhere in the
   editor to collapse the selection (or press →).
2. **Expected:** popup hides immediately.

### A4 — Hidden in read-only modes

1. Switch the editor mode to `View` (Eye icon) or `Review`.
2. Select text.
3. **Expected:** no selection toolbar (read-only modes hide both static and
   selection toolbars).

### A5 — Suppressed while LinkPopup is open

1. Select text and click the **Link** button in the selection toolbar (or
   the static toolbar) → the link input popup opens.
2. **Expected:** the selection toolbar does NOT render alongside the link
   input — only the link popup is visible.

### A6 — Position flips below near top of viewport

1. Scroll so the selected text is within ~40px of the top of the editor
   pane, then make a selection.
2. **Expected:** the popup renders BELOW the selection (not clipped above
   the viewport).

---

## B. Markdown editor header

### B1 — No "Wiki" back button

1. Open any markdown doc (`/dock/assets/editor/markdown/...`).
2. Inspect the header bar (52px, above the Properties block).
3. **Expected:** no back button labelled `← Wiki` on the left. The header
   shows: filename + dirty indicator, mode toggle group, copy-path icon.

---

## C. Quick-create doc in project room

The Docs sidebar in `/dock/project/<id>` exposes a `+` button that creates
a new markdown file under `.claude/docs/`. Creation goes through the
entity-style API: `Markdown.createInProject(project, name)` →
`new Markdown({name}).save([project.typeId])`. The backend writes the file
inside `Entity.save()` (no client-side `indexType` call needed).

### C1 — `+` button location

1. Navigate to `/dock/project/<any-project-id>`.
2. Look at the left sidebar's **DOCS** category header row.
3. **Expected:** the `+` icon (aria-label `New doc`) sits to the right of
   the "DOCS" label, in the SAME row as the chevron and section icon —
   never on its own empty row.

### C2 — Create dialog opens

1. Click the `+` button.
2. **Expected:** a modal dialog titled "New doc" opens with input
   placeholder "doc name" and a Create button. Description reads
   ".claude/docs/ under this project".

### C3 — Doc creation: file + sidebar + tab in one shot

1. Type a unique name, e.g. `regression-c3-<timestamp>`, click **Create**.
2. **Expected (all three must hold):**
   - Toast appears: "Doc created".
   - The new doc shows up in the DOCS list IMMEDIATELY (no page reload, no
     manual scan).
   - A new tab opens in the room tabs strip (above the terminal area)
     with the doc name as the title; the tab's body is the markdown
     editor mounted on the new file.

### C4 — Auto-`Show system` in Flowpad Assistant collab

1. Navigate to `/dock/project/@flowpad_assistant`.
2. Inspect the DOCS category.
3. **Expected:** the "Show system" toggle row is hidden (system project
   auto-includes its own docs); `hello-flowpad.md` is visible in the list.

### C5 — Non-system project hides system docs by default

1. Navigate to `/dock/project/<a-regular-project-id>` (any non-system
   project).
2. **Expected:** the DOCS category shows the "Show system" checkbox row
   UNCHECKED by default; only that project's user-authored docs appear.
3. Tick the checkbox → system docs (e.g. `hello-flowpad.md`) appear.

### C6 — Click an existing doc opens as room tab (not navigation)

1. In the DOCS list, click an existing doc.
2. **Expected:** a new room tab opens with the doc; the URL stays at
   `/dock/project/<id>` (no navigation away).

---

## D. Project entity routing

Project rows must NOT open in the asset editor — they redirect to the
project's collaboration space.

### D1 — Project row in `/dock/assets/list/project`

1. Navigate to `/dock/assets/list/project`.
2. Click any row.
3. **Expected:** URL changes to `/dock/project/<projectId>`; the project
   collaboration page renders. No "No editor for type: project" message
   appears at any point.

### D2 — Project row from browseable tree

1. Open a wiki/asset surface that uses the BrowseableTree (e.g. AssetsPage
   sidebar) and expand the **Project** type group.
2. Click a project entry in the tree.
3. **Expected:** navigates to `/dock/project/<projectId>` (not an asset
   editor URL).

### D3 — Direct asset-editor URL for project (defensive)

1. Manually visit a stale URL of the form
   `/dock/assets/editor/project/<some-path>`.
2. **Expected:** does NOT show "No editor for type: project". (Acceptable
   states: project type is now routed to the collab space at the click
   site, so this URL shape should no longer be produced; if it is reached
   directly, the page must not crash.)

---

## E. Phase 4 — Flowpad Assistant collab integration

These are the original Phase 4 plan scenarios; keep them in regression
because they cover the system-project end-to-end path.

### E1 — Sample doc visible in Flowpad Assistant collab

1. Navigate to `/dock/project/@flowpad_assistant`.
2. **Expected:** `hello-flowpad.md` is visible in the DOCS sidebar.
3. Click it → the markdown editor opens in view mode rendering
   "Hello from Flowpad" as the heading.

### E2 — Bootstrap markdown scan (backend)

1. Delete the FTS row:
   `sqlite3 <db> "DELETE FROM entities WHERE type='markdown' AND json_extract(data, '$.name')='hello-flowpad'"`.
2. Restart the backend.
3. Hit `GET /api/v1/graph/bootstrap`.
4. **Expected:** the row reappears in the DB with `system=1` (bootstrap
   triggers a markdown scan after ensuring system projects).

### E3 — Server `include_system` filter default

1. `curl '<base>/api/v1/search?record_type=markdown&q=hello-flowpad'`.
2. **Expected:** 0 results (system records hidden by default).
3. `curl '<base>/api/v1/search?record_type=markdown&q=hello-flowpad&include_system=true'`.
4. **Expected:** 1 result.

### E4 — Footer "Flowpad docs" button

1. From any view, look at the application footer.
2. **Expected:** a "Flowpad docs" button left of the ClaudeUsageChip.
3. Click it.
4. **Expected:** navigates to `/dock/project/@flowpad_assistant`.

---

## F. TypeScript / build sanity

Run before merging any change to UI code.

### F1 — UI typecheck

```bash
npx tsc --noEmit -p ui
```

**Expected:** exit code 0, no diagnostics.

### F2 — Vite dep cache (when adding/removing SDK exports)

If a previously exported symbol is renamed or removed (e.g. `MarkdownAsset`
→ `Markdown`), clear Vite's pre-bundled deps before retesting:

```bash
rm -rf ui/node_modules/.vite
```

Then reload the dev page. **Expected:** no "does not provide an export
named X" errors in the console.
