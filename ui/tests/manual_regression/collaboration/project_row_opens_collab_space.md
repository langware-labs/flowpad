---
id: 5633647f-6bef-5ce0-af33-7476965aa9a2
---

# Note (2026-05-31): `/dock/project/<id>` intentionally renders the project ASSET BROWSER
# (record-removal branch UX), not the legacy CollaborationPage DOCS/ROOMS/PLANS sidebar.
# These tests assert the current, intended surface.

test 1: Clicking a project row in the asset list navigates to the project view
- navigate to {APP_URL}/dock/assets/list/project
- wait for at least one row with a <td> to render in the table
- record the project's record_id from the row (or first row's first <td> text as the project label)
- click the first project row
- wait up to 1 second for navigation
- validate the URL matches /dock/project/<uuid> (a 36-char UUID-shaped projectId, e.g. /dock/project/8463c0d4-d00d-5f61-a5b4-55abc26c95ab)
- validate the page does NOT contain the text "No editor for type: project"
- validate the project asset browser rendered (look for the "Assets" heading and a "Project: <name>" scope indicator, with the asset-type tree / "Select a type to browse" prompt)
- check console for errors
- validate no errors appeared

test 2: Project row in the BrowseableTree (assets sidebar) opens the project view
- navigate to {APP_URL}/dock/assets
- in the left BrowseableTree, expand the "Project" type node
- wait for project children to render
- click the first project child
- validate the URL changes to /dock/project/<uuid>
- validate no "No editor for type: project" text on the page

test 3: Project rows in /dock/assets/list/project are visually clickable
- navigate to {APP_URL}/dock/assets/list/project
- inspect the className of any data row (<tr> with <td>)
- validate the row className contains "cursor-pointer" (project rows must indicate they are clickable, since hasEditor('project') is true)
