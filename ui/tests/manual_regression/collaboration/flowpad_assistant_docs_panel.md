---
id: 8a3c1f29-4b7e-4d6a-9f12-2c5e8a1b3d40
---

# Flowpad Assistant — project view (system space)
# Note (2026-05-31): `/dock/project/<id>` renders the project ASSET BROWSER
# (record-removal branch UX), not the legacy DOCS/ROOMS/PLANS CollaborationPage.
# The assistant's docs are reachable as markdown assets via that browser. These
# tests assert the current, intended surface (asset browser mounts cleanly +
# the shipped doc is seeded/searchable), not the removed DOCS sidebar.

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

test 2: The shipped hello-flowpad doc is seeded and searchable
# Startup and desktop reset synchronously seed the Flowpad Assistant's shipped
# markdown entities and their FTS rows. A manual broad re-index would mask a
# broken reset contract, so query the exact system-project scope directly.
- resolve the @flowpad_assistant Project entity id
- [bash] run "curl -s '{API_URL}/api/v1/search?record_type=markdown&q=hello&include_system=true&user=false&projects={PROJECT_ID}'"
- validate the search response includes the shipped "Hello from Flowpad" entity with id dc8713d4-8841-47ab-a28d-8e3248106f5a and the resolved project id

test 3: The assistant project view mounts without an error boundary
- navigate to {APP_URL}/dock/project/@flowpad_assistant
- wait for the project view to render
- validate no React error boundary is visible (no heading "Error" / "Something went wrong")
- check console for errors
- validate no errors appeared
