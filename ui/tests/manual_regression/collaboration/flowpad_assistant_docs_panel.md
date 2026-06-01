---
id: 8a3c1f29-4b7e-4d6a-9f12-2c5e8a1b3d40
---

# Flowpad Assistant — project view (system space)
# Note (2026-05-31): `/dock/project/<id>` renders the project ASSET BROWSER
# (record-removal branch UX), not the legacy DOCS/ROOMS/PLANS CollaborationPage.
# The assistant's docs are reachable as markdown assets via that browser. These
# tests assert the current, intended surface (asset browser mounts cleanly +
# the seeded doc is indexed/searchable), not the removed DOCS sidebar.

test 1: Open the Flowpad Assistant space from the sidebar
- navigate to {APP_URL}/dock/home
- wait for the sidebar to render
- click the "Flowpad Assistant" button in the sidebar (data-testid="sidebar-flowpad-assistant" or text "Flowpad Assistant")
- wait up to 2 seconds for navigation
- validate the URL contains "/dock/project/" (the assistant opens its project space)
- validate the project asset browser rendered (the "Assets" heading and a "Project: @flowpad" scope indicator with the asset-type tree)
- validate the page does NOT contain the text "No editor for type: project"
- check console for errors
- validate no errors appeared

test 2: The seeded hello-flowpad doc is indexed and searchable
- [bash] run "curl -s -X POST '{API_URL}/api/v1/graph/compute_node/@local/fs-records/index?type=markdown'"
- [bash] run "sleep 2"
- [bash] run "curl -s '{API_URL}/api/v1/search?record_type=markdown&q=hello&include_system=true'"
- validate the search response includes a result whose name/path contains "hello-flowpad" (the seeded system doc is discoverable after indexing)

test 3: The assistant project view mounts without an error boundary
- navigate to {APP_URL}/dock/project/@flowpad_assistant
- wait for the project view to render
- validate no React error boundary is visible (no heading "Error" / "Something went wrong")
- check console for errors
- validate no errors appeared
