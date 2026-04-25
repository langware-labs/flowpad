test 1: Clicking a project row in the asset list navigates to the project's collab space (not the asset editor)
- navigate to {APP_URL}/dock/assets/list/project
- wait for at least one row with a <td> to render in the table
- record the project's record_id from the row (or first row's first <td> text as the project label)
- click the first project row
- wait up to 1 second for navigation
- validate the URL matches /dock/project/<uuid> (a 36-char UUID-shaped projectId, e.g. /dock/project/8463c0d4-d00d-5f61-a5b4-55abc26c95ab)
- validate the page does NOT contain the text "No editor for type: project"
- validate the CollaborationPage rendered (look for the project room layout: terminal panel area + sidebar with DOCS / ROOMS / PLANS categories, OR the EmptyState "No collaboration open" if the project has no room yet)
- check console for errors
- validate no errors appeared

test 2: Project row in the BrowseableTree (assets sidebar) opens the project's collab space
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
