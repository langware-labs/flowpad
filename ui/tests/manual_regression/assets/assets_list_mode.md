# Assets Page — List Mode Navigation

## Summary
Verifies the new list-mode sidebar and search/browse experience added in the Search-First Asset Management UI feature. The default view should be list mode with a type sidebar on the left and a search-able data table on the right.

## Preconditions
- App is running at http://localhost:4097
- Backend is running at http://localhost:9007
- Bootstrap has been called (entities exist)

## Steps

### 1. Navigate to Assets page
1. Open the app at http://localhost:4097
2. Click on the "Assets" tab or navigate to the assets section
3. **Expected**: The Assets page loads in **list mode** by default (not hierarchy mode)
4. **Expected**: A type sidebar appears on the left side with clickable type pills (e.g. "Asset", "Skill", "Agent", "Task", etc.)
5. **Expected**: The right panel shows "Select a type to browse"

### 2. Verify mode toggle buttons
1. Look at the header area of the Assets page
2. **Expected**: Two toggle buttons visible — one for list mode (LayoutList icon) and one for hierarchy mode (Network icon)
3. **Expected**: The list mode button appears active/selected (secondary variant)

### 3. Browse by type
1. Click on "Skill" in the type sidebar (or any available type)
2. **Expected**: The right panel shows a data table (possibly empty or with results)
3. **Expected**: A search input bar appears above the table
4. **Expected**: A filter bar area appears (QuickFilterBar)
5. **Expected**: Pagination controls appear at the bottom of the table (if there are multiple pages)

### 4. Switch to hierarchy mode
1. Click the hierarchy mode toggle button (Network icon) in the header
2. **Expected**: The sidebar changes to show the asset tree (old behavior)
3. **Expected**: The right panel shows the asset editor
4. **Expected**: The hierarchy mode button is now active/selected

### 5. Switch back to list mode
1. Click the list mode toggle button (LayoutList icon)
2. **Expected**: Returns to list mode with type sidebar
3. **Expected**: Previously selected type (if any) is remembered

### 6. API smoke test — /api/v1/assets/types
1. Open a new browser tab or use the network panel
2. Navigate to http://localhost:9007/api/v1/assets/types
3. **Expected**: Returns JSON with `status: "SUCCESS"` and `data.types` array
4. **Expected**: Array contains entries for asset, skill, agent, workflow, task, bookmark types

## Pass Criteria
- [ ] Assets page loads in list mode by default
- [ ] Type sidebar shows user-facing record types
- [ ] Clicking a type shows the browse table
- [ ] Search input filters results (after typing 2+ chars)
- [ ] Mode toggle switches between list and hierarchy
- [ ] Hierarchy mode still shows tree + editor as before
- [ ] `/api/v1/assets/types` endpoint returns correct types

## Notes
- This is a new feature — first-time coverage
- The search API now supports empty-query browsing via `/api/v1/search?record_type=...&offset=0&limit=20`
