test 1: Folder tree renders markdown vault roots on expand
- [browser] navigate to {APP_URL}/dock/assets/list/markdown
- [browser] wait for page to load
- [browser] validate the element with data-testid="browseable-chevron-asset-type:markdown" is visible
- [browser] click the element with data-testid="browseable-chevron-asset-type:markdown"
- [browser] wait for a tree treeitem at aria-level 2 to appear
- [browser] validate at least one element with label matching "User docs", "Project docs", or "Workspace docs" is visible

test 2: Clicking a folder navigates to folder URL and shows breadcrumb
- [browser] navigate to {APP_URL}/dock/assets/list/markdown
- [browser] wait for page to load
- [browser] click the element with data-testid="browseable-chevron-asset-type:markdown"
- [browser] wait for a treeitem at aria-level 2 to appear
- [browser] click the first vault-root row (e.g. "User docs" or "Project docs (...)")
- [browser] wait for navigation
- [browser] validate the URL contains "/dock/assets/folder/markdown/"
- [browser] validate the element with data-testid="asset-list-breadcrumb" is visible

test 3: Clicking a subfolder deepens the URL and narrows the list
- [browser] navigate to {APP_URL}/dock/assets/list/markdown
- [browser] wait for page to load
- [browser] click the element with data-testid="browseable-chevron-asset-type:markdown"
- [browser] wait for a treeitem at aria-level 2 to appear
- [browser] click the first vault-root row
- [browser] validate the URL contains "/dock/assets/folder/markdown/"
- [browser] locate a folder row at aria-level 3 (a child of the vault)
- [browser] click the folder row
- [browser] wait for navigation
- [browser] validate the URL contains "/dock/assets/folder/markdown/"
- [browser] validate the URL segment count has increased by one vs. the previous step
- [browser] validate the breadcrumb at data-testid="asset-list-breadcrumb" contains the subfolder name

test 4: Clear button returns to the full markdown list
- [browser] navigate to {APP_URL}/dock/assets/list/markdown
- [browser] wait for page to load
- [browser] click the element with data-testid="browseable-chevron-asset-type:markdown"
- [browser] click the first vault-root row
- [browser] validate the element with data-testid="asset-list-breadcrumb-clear" is visible
- [browser] click the element with data-testid="asset-list-breadcrumb-clear"
- [browser] wait for navigation
- [browser] validate the URL ends with "/dock/assets/list/markdown"
- [browser] validate the element with data-testid="asset-list-breadcrumb" is not visible

test 5: Clicking a markdown file opens the editor while keeping the tree visible
- [browser] navigate to {APP_URL}/dock/assets/list/markdown
- [browser] wait for page to load
- [browser] click the element with data-testid="browseable-chevron-asset-type:markdown"
- [browser] click the first vault-root row
- [browser] locate any file row (a treeitem whose label ends with ".md")
- [browser] click the file row
- [browser] wait for navigation
- [browser] validate the URL contains "/dock/assets/editor/markdown/"
- [browser] validate the element with role="tree" is still visible
- [browser] validate the selected file row has aria-selected="true"

test 6: Deep-link to a markdown file auto-expands ancestors
- [browser] first run test 5 to discover a valid editor URL, copy it (e.g. /dock/assets/editor/markdown/<abs>)
- [browser] navigate to a new tab at that editor URL
- [browser] wait for page to load
- [browser] validate the element with role="tree" is visible
- [browser] validate the ancestor vault row has aria-expanded="true"
- [browser] validate the file's row has aria-selected="true"

test 7: Deep-link to a folder auto-expands and shows breadcrumb
- [browser] navigate to {APP_URL}/dock/assets/list/markdown
- [browser] click the element with data-testid="browseable-chevron-asset-type:markdown"
- [browser] click any vault row then any subfolder row to compute a target URL (copy from the address bar)
- [browser] navigate to that folder URL in a new tab
- [browser] wait for page to load
- [browser] validate the element with data-testid="asset-list-breadcrumb" is visible
- [browser] validate the tree's ancestor folders have aria-expanded="true"

test 8: Sidebar collapse works in folder mode and preserves URL
- [browser] navigate to {APP_URL}/dock/assets/list/markdown
- [browser] click the element with data-testid="browseable-chevron-asset-type:markdown"
- [browser] click the first vault-root row
- [browser] locate the button with aria-label="Hide wiki tree"
- [browser] click the Hide button
- [browser] validate the URL is unchanged (still contains "/folder/markdown/")
- [browser] locate the button with aria-label="Show wiki tree"
- [browser] click the Show button
- [browser] validate the element with role="tree" is visible again

test 9: Scan toolbar action on the Markdown root triggers reindex
- [browser] navigate to {APP_URL}/dock/assets/list/markdown
- [browser] wait for page to load
- [browser] hover over the Markdown treeitem at aria-level 1
- [browser] validate the element with data-testid="browseable-toolbar-scan:markdown" is visible
- [browser] click the element with data-testid="browseable-toolbar-scan:markdown"
- [browser] validate the network request to POST /api/v1/graph/compute_node/@local/fs-records/index?type=markdown is made (inspect dev tools Network tab)
- [browser] validate no console errors were logged

test 10: New markdown toolbar action opens the creation dialog
- [browser] navigate to {APP_URL}/dock/assets/list/markdown
- [browser] wait for page to load
- [browser] hover over the Markdown treeitem at aria-level 1
- [browser] validate the element with data-testid="browseable-toolbar-new:markdown" is visible
- [browser] click the element with data-testid="browseable-toolbar-new:markdown"
- [browser] validate a dialog opens with title "New markdown"
- [browser] press Escape to dismiss

test 11: Multiple vault roots all appear
- [browser] navigate to {APP_URL}/dock/assets/list/markdown
- [browser] wait for page to load
- [browser] click the element with data-testid="browseable-chevron-asset-type:markdown"
- [browser] count the treeitems at aria-level 2 that are vault roots
- [browser] validate the count is >= 1 (user environments typically show at least "Workspace docs" or "Project docs (...)")

test 12: Empty vault expansion shows empty state
- [browser] prerequisite: a markdown vault exists with no .md files (FLOWPAD_DOC_DIRS pointing at a temp empty dir for repeatability)
- [browser] navigate to {APP_URL}/dock/assets/list/markdown
- [browser] click the element with data-testid="browseable-chevron-asset-type:markdown"
- [browser] click the chevron of the empty vault row
- [browser] validate the text "Empty" is visible under that vault row

test 13: Unknown folder deep-link shows empty list and breadcrumb without crashing
- [browser] navigate to {APP_URL}/dock/assets/folder/markdown/compute_node-@local/definitely/not/a/real/folder
- [browser] wait for page to load
- [browser] validate the page does not show an error boundary
- [browser] validate the element with data-testid="asset-list-breadcrumb" is visible (may show vault fallback or empty crumbs)
- [browser] validate no console errors were logged

test 14: Flat list regression for non-markdown types
- [browser] navigate to {APP_URL}/dock/assets/list/skill
- [browser] wait for page to load
- [browser] click the element with data-testid="browseable-chevron-asset-type:skill"
- [browser] validate at least one asset leaf appears as a direct child (flat list, NOT nested folders)
- [browser] click the first skill leaf
- [browser] validate the URL contains "/dock/assets/editor/skill/"

test 15: parent_path filter does not leak into flat mode
- [browser] navigate to {APP_URL}/dock/assets/list/markdown
- [browser] wait for page to load
- [browser] type any 2-character query into the right-panel search input (data-testid="asset-search-input" or first text input in the list header)
- [browser] validate the results shown are NOT filtered by parent_path (total count matches the unfiltered /search response)

test 16: Switching from folder to list mode preserves scope filter
- [browser] navigate to {APP_URL}/dock/assets/list/markdown
- [browser] change scope to "User" in the header ScopeFilterBar
- [browser] click the element with data-testid="browseable-chevron-asset-type:markdown"
- [browser] click the first vault row
- [browser] validate the URL contains "/dock/assets/folder/markdown/"
- [browser] validate the header ScopeFilterBar still shows "User" selected
- [browser] click the element with data-testid="asset-list-breadcrumb-clear"
- [browser] validate the header ScopeFilterBar still shows "User" selected
