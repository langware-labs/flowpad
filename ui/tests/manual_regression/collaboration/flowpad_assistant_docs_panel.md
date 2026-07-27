---
id: 8a3c1f29-4b7e-4d6a-9f12-2c5e8a1b3d40
---

# Flowpad Assistant — project view (system space)
# Note (2026-05-31): `/dock/project/<id>` renders the project ASSET BROWSER
# (record-removal branch UX), not the legacy DOCS/ROOMS/PLANS CollaborationPage.
# The assistant's docs are reachable as markdown assets via that browser. These
# tests assert the current, intended surface (asset browser mounts cleanly +
# the seeded doc is indexed/searchable), not the removed DOCS sidebar.

# Corrected 2026-06-04: the "Flowpad Assistant" button (FlowpadAssistantButton)
# toggles the global FLOATING CHAT — it does NOT navigate to /dock/project/.
# The assistant's project space is reached by direct navigation to
# /dock/project/@flowpad_assistant, which renders the asset browser. Rewritten
# to that real surface.

test 1: Open the Flowpad Assistant project space (asset browser)
- navigate to {APP_URL}/dock/project/@flowpad_assistant
- wait for the project view to render
- validate the project asset browser rendered (the "Project assets" header and the project-name chip scope indicator with the asset-type tree)
- validate the page does NOT contain the text "No editor for type: project"
- check console for errors
- validate no errors appeared

test 2: The seeded hello-flowpad doc is indexed and searchable
# Scope the index to the @flowpad_assistant system project (where the seeded
# doc lives). An unscoped `index?type=markdown` walks every registered root
# (the whole home tree) to discover markdown, a ~150s op on a real machine that
# exceeds the 60s cap; the claim is only that the SEEDED doc indexes, so index
# exactly that doc's project (one small subtree, sub-second).
# force=true is required: the harness's `desktop-db/clear` wipes DB+FTS but
# leaves the on-disk `.hash` sentinels, so a plain index hits skip-fresh and
# re-creates entity rows WITHOUT repopulating FTS (search finds nothing). force
# bypasses skip-fresh and rewrites FTS. (Production rebuild clears sentinels
# itself; this is specific to the clear-then-bare-index sequence.)
- [bash] run "curl -s -X POST '{API_URL}/api/v1/graph/compute_node/@local/fs-records/index?type=markdown&user=false&projects=@flowpad_assistant&force=true'"
- [bash] run "sleep 2"
- [bash] run "curl -s '{API_URL}/api/v1/search?record_type=markdown&q=hello&include_system=true'"
- validate the search response includes a result whose name/path contains "hello-flowpad" (the seeded system doc is discoverable after indexing)

test 3: The assistant project view mounts without an error boundary
- navigate to {APP_URL}/dock/project/@flowpad_assistant
- wait for the project view to render
- validate no React error boundary is visible (no heading "Error" / "Something went wrong")
- check console for errors
- validate no errors appeared
