---
id: 79e55ed3-1173-53ca-ad86-0f3f8a597ab6
---

# Assets Page — Browseable Tree + AssetListView

## Summary
Verifies the Assets page at `/dock/assets` and `/dock/assets/list/<type>`. The
page renders a collapsible **BrowseableTree** sidebar (asset types as tree
roots) on the left and either a "Select a type to browse" placeholder or an
**AssetListView** on the right, depending on the URL.

This scenario replaces the older "Search-First UI" spec, which described a
LayoutList/Network mode toggle + type pills that never shipped — none of those
elements exist in the current codebase (`AssetsPage.tsx`, `AssetListView.tsx`).

## Preconditions
- App is running at {APP_URL}
- Backend is running at {API_URL}
- Bootstrap has been called (entities exist). If the DB has been cleared, a
  background bootstrap will re-index; some tests may need a 1-2s settle.

## Notes for the tester
- The chevron data-testid carries a filter-signature suffix:
  `browseable-chevron-asset-type:<type>:<scope>:<projectIds>`. Always use a
  **prefix match** (`starts with "browseable-chevron-asset-type:<type>:"`),
  never the bare literal. Same for `browseable-toolbar-*` ids.
- The bare `/dock/assets` URL should NOT render an AssetListView until a type
  is selected — by either clicking a tree node or navigating to
  `/dock/assets/list/<type>`.

## Steps

### test 1: /dock/assets renders the BrowseableTree sidebar + placeholder right panel
- [browser] navigate to {APP_URL}/dock/assets
- [browser] wait for page to load
- [browser] validate the element with role="tree" is visible (the asset-type sidebar)
- [browser] validate at least one treeitem at aria-level 1 is visible
- [browser] validate the text "Select a type to browse" is visible somewhere on the page

### test 2: Header renders the assets controls (no LayoutList/Network toggles)
- [browser] navigate to {APP_URL}/dock/assets
- [browser] wait for page to load
- [browser] validate the text "Assets" is visible (page title)
- [browser] validate NO element matching `[aria-label*="hierarchy"], [aria-label*="list mode"], button:has(svg.lucide-layout-list), button:has(svg.lucide-network)` exists
- [browser] validate the element with data-testid="rebuild-index" exists (the PackageSearch refresh button) OR a button with title "Refresh search data"

### test 3: Navigate to /dock/assets/list/skill — AssetListView renders
- [browser] navigate to {APP_URL}/dock/assets/list/skill
- [browser] wait for page to load
- [browser] validate the text "Select a type to browse" is NOT visible
- [browser] validate at least one text input is rendered in the right panel (search/tag input above the table)
- [browser] validate either a table OR an empty-state message ("No results found", "No skills", etc.) is visible

### test 4: Sidebar treeitems include known asset types
- [browser] navigate to {APP_URL}/dock/assets
- [browser] wait for page to load
- [browser] validate treeitems with names "Agent", "Skill", "Workflow", and "Markdown" each appear in the role="tree" (case-insensitive)

### test 5: Expand a type via its chevron prefix-match selector
- [browser] navigate to {APP_URL}/dock/assets/list/skill
- [browser] wait for page to load
- [browser] click the first element whose data-testid starts with "browseable-chevron-asset-type:skill:"
- [browser] wait up to 3s for at least one treeitem at aria-level 2 to appear under the skill root

### test 6: API smoke test — /api/v1/assets/types
- [bash] curl -s {API_URL}/api/v1/assets/types | jq -r '.status'
- [bash] expect `SUCCESS`
- [bash] curl -s {API_URL}/api/v1/assets/types | jq -r '.data.types[].type_name' | sort
- [bash] validate the output INCLUDES at least: `agent`, `skill`, `workflow`, `markdown`. (The set may also include `spec`, `claude_md`, `claude_memory`, `plan`, `claude_rules`, `project`, etc. — do not assert exact equality, the registry evolves; assert subset only.)

## Pass Criteria
- [ ] /dock/assets renders a tree + placeholder right panel
- [ ] Header has page title and the refresh button (no LayoutList/Network toggles)
- [ ] /dock/assets/list/<type> renders an AssetListView (not the placeholder)
- [ ] Sidebar contains the core asset-type roots
- [ ] Chevron prefix-match selectors expand the type subtree
- [ ] `/api/v1/assets/types` returns SUCCESS and includes at least the core set

## Notes
- Rewritten 2026-05-12 after a prior cycle found the original scenario
  described a phantom UI variant (LayoutList/Network mode toggles + type pills)
  that doesn't exist in the codebase. The actual implementation is the
  BrowseableTree + AssetListView wiring in `ui/src/components/assets/`.
