---
id: 5633647f-6bef-5ce0-af33-7476965aa9a2
---

# Note (2026-05-31): `/dock/project/<id>` intentionally renders the project ASSET BROWSER
# (record-removal branch UX), not the legacy CollaborationPage DOCS/ROOMS/PLANS sidebar.
# These tests assert the current, intended surface.

# Corrected 2026-06-04: `project` is NOT in EDITOR_TYPES (ts_sdk asset-editor.ts),
# so hasEditor('project') is FALSE. AssetsPage wires onRowClick only when
# hasEditor(selectedType) is true, so project rows in /dock/assets/list/project
# are deliberately NOT click-targets (no cursor-pointer). Project navigation
# instead flows through navigateToResult's `project` case (record-type-nav.ts)
# from the BrowseableTree / search, and `/dock/project/<uuid>` directly renders
# the asset browser. The original tests 1+3 asserted a false list-row-click
# contract; rewritten to the actual surface.

test 1: Direct navigation to /dock/project/<uuid> renders the project asset browser
- navigate to {APP_URL}/dock/project/<a real project uuid from GET /api/v1/graph/project>
- validate the URL matches /dock/project/<uuid> (36-char UUID-shaped projectId)
- validate the page does NOT contain the text "No editor for type: project"
- validate the project asset browser rendered (the "Assets" heading and a "Project: <name>" scope indicator, with the asset-type tree / "Select a type to browse" prompt)
- check console for errors
- validate no errors appeared

# Corrected 2026-06-04: the BrowseableTree groups assets by editable TYPE
# (Spec, Agent, Workflow, Skill, Whiteboard, Markdown, Claude Memory/Rules,
# Plan, Dataset) — there is NO "Project" type node in the tree (project has no
# asset editor). The project surface in the asset browser is the project-scope
# filter chip in the search bar. Rewritten to that real affordance.

test 2: The asset browser exposes a project-scope filter chip
- navigate to {APP_URL}/dock/assets
- wait for the asset browser to render
- validate a project-scope filter control is present (a "Project …" chip / "Project filter" button in the search bar)
- validate the BrowseableTree groups assets by type (e.g. an "Agent" or "Markdown" type node is present) and has no "Project" type node

test 3: Project rows in /dock/assets/list/project are NOT row-click targets (hasEditor('project') is false)
- navigate to {APP_URL}/dock/assets/list/project
- wait for at least one row with a <td> to render in the table
- inspect the className of any data row (<tr> with <td>)
- validate the row className does NOT contain "cursor-pointer" (project has no asset editor, so AssetsPage leaves onRowClick undefined)
