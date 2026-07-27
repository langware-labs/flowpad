---
id: d0c8a8e6-41d7-5afb-9fdc-9e4346f9c767
---

# Project doc creation — entity-API path
# Note (2026-05-31): `/dock/project/<id>` renders the project ASSET BROWSER
# (record-removal branch UX), not the legacy DOCS-sidebar CollaborationPage with
# an inline "New doc" button. Doc creation is exercised via the entity API
# (`new Markdown({name}).save([projectTypeId])` -> POST /api/v1/graph/markdown),
# which is the surface the app now uses. These tests assert that path.

test 1: Project view mounts the asset browser (not a legacy DOCS sidebar)
- navigate to {APP_URL}/dock/project/@flowpad_assistant
- wait for the project view to render
- validate the "Project assets" header and the project-name chip scope indicator are present (asset browser)
- validate the page does NOT contain the text "No editor for type: project"
- check console for errors
- validate no errors appeared

test 2: Creating a markdown doc via the entity API writes the entity (and is searchable)
- [bash] run "curl -s -X POST '{API_URL}/api/v1/graph/markdown' -H 'Content-Type: application/json' -d '{\"name\":\"regression_new_doc_check\",\"body\":\"# regression\\nnew doc body\\n\"}'"
- validate the response status is "SUCCESS" and data.id is a UUID
- validate data.type == "markdown" and data.name == "regression_new_doc_check"
- [bash] run "curl -s -X POST '{API_URL}/api/v1/graph/compute_node/@local/fs-records/index?type=markdown'"
- [bash] run "sleep 2"
- [bash] run "curl -s '{API_URL}/api/v1/search?record_type=markdown&q=regression_new_doc_check'"
- validate the search response total >= 1 and a result name contains "regression_new_doc_check"

test 3: The markdown editor surface opens for an existing doc
- navigate to {APP_URL}/dock/assets/list/markdown
- wait for the markdown asset list to render (a table with rows OR the "No results found" empty-state)
- if at least one row exists, click the first markdown row
- validate the URL changes (markdown editor route) and no "No editor for type" text appears
- check console for errors
- validate no errors appeared
