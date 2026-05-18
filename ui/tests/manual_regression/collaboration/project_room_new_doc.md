---
id: d0c8a8e6-41d7-5afb-9fdc-9e4346f9c767
---

test 1: "+" New-doc button is in the DOCS category header row, never on its own
- navigate to {APP_URL}/dock/project/@flowpad_assistant
- wait for the left sidebar to render
- locate the row containing the text "DOCS" (uppercase, with a chevron and FileText icon)
- validate the button with aria-label="New doc" is in the SAME row as the chevron + label (not on a separate row below)
- collapse the DOCS category by clicking the row's main button area
- validate the "New doc" button stays in the same header row even when the category is collapsed

test 2: New-doc dialog opens with correct copy
- click the button with aria-label="New doc"
- wait for the modal dialog (role="dialog") to open
- validate the dialog title is "New doc"
- validate the dialog description text is ".claude/docs/ under this project"
- validate the input has placeholder "doc name"
- validate the confirm button label is "Create"

test 3: Creating a doc writes the file, refreshes the menu, and opens it as a room tab in one shot
- navigate to {APP_URL}/dock/project/<any-non-system-project-id>
- click the button with aria-label="New doc"
- type a unique name, e.g. "regression-c3-<timestamp>"
- click the Create button
- wait up to 4 seconds for the create round-trip
- validate a toast with title "Doc created" appeared
- validate the new doc name appears in the DOCS list (a <li> child of the DOCS category)
- validate a new room tab appears above the terminal area with the doc name as its label
- validate the active tab body contains a .ProseMirror or .milkdown editor surface mounted on the new file

test 4: Clicking an existing doc in the DOCS list opens it as a room tab without leaving the project
- with at least one doc in the DOCS list (run test 3 first or pick any existing doc)
- record the current URL (should be /dock/project/<id>)
- click the doc <li> in the DOCS list
- wait 500 ms
- validate the URL is unchanged (no navigation away from the project room)
- validate a room tab opens with that doc and the markdown editor renders it

test 5: Auto-"Show system" inside the Flowpad Assistant collab space
- navigate to {APP_URL}/dock/project/@flowpad_assistant
- expand the DOCS category if collapsed
- validate the "Show system" toggle row is HIDDEN inside this collab (system project auto-includes its own docs — surfacing the toggle would be pointless)
- validate the doc named "hello-flowpad" is visible in the DOCS list

test 6: Non-system project hides system docs by default
- navigate to {APP_URL}/dock/project/<any-non-system-project-id>
- expand the DOCS category
- validate the "Show system" checkbox row IS shown and the checkbox is UNCHECKED
- validate "hello-flowpad" is NOT in the DOCS list
- click the "Show system" checkbox to enable it
- wait 500 ms for the search to refresh
- validate "hello-flowpad" now appears in the DOCS list

test 7: Doc creation uses the entity-style API (no client-side scan call)
- open browser DevTools Network tab
- navigate to {APP_URL}/dock/project/<any-non-system-project-id>
- click "New doc", type a unique name, click Create
- inspect the network log for the create round-trip
- validate there is a POST to /api/v1/graph/markdown (or the standard Entity.save POST shape) — this is `new Markdown({name}).save([projectTypeId])`
- validate there is NO POST to /api/v1/fs-records/index?type=markdown (server now writes the file inside Entity.save; client must not trigger a manual indexer pass)
