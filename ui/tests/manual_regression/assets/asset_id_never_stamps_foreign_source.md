---
id: e4bacbf6-118a-45d3-a119-abc2899d1d01
---

test 1: opening a .py under the markdown editor never stamps an id into it (FLOWPAD-2083)
- [setup] create an isolated temporary project containing agentic-assets/mcp/crm-mcp/server.py (an MCP server folder with no mcp.json, so no type claims it)
- [browser] open /dock/assets/editor/markdown/vfs/<server.py> — the shape DockPointer.forAssetEditor emits when a type has no editor of its own
- [browser] validate the editor mounted on server.py (crumb shows server.py)
- [browser] wait for the path resolver's response for server.py (GET /api/v1/assets/resolve?path=… — it replaced the retired /fs-records/<type>/discover call) so the resolve/mint seam has run to completion
- [browser] validate the file content is shown
- [setup] validate the bytes on disk are unchanged — no frontmatter id was prepended
