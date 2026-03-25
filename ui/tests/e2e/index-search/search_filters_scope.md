test 1: Home page shows search bar with scope filter options (All/User/Project)
- [browser] navigate to {APP_URL}/
- [browser] wait for page to load (networkidle)
- [browser] click the "Tools" button (data-testid="search-tools-btn")
- [browser] validate the filter panel appears (data-testid="search-filter-panel")
- [browser] validate the filter panel contains scope options "All", "User", "Project" (or equivalent)

test 2: Selecting "User" scope restricts search results to user-scoped records
- [browser] navigate to {APP_URL}/dock/search
- [browser] wait for page to load
- [browser] open the filter panel
- [browser] click the "User" scope option
- [browser] validate the scope filter is now set to "User"
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/search?scope=user&q=test
- [api] validate HTTP response status is 200
- [api] validate every result in data.results has scope="user" (if results exist)

test 3: Selecting "Project" scope opens project picker modal
- [browser] navigate to the assets page or search filter panel
- [browser] click the "Project" scope button
- [browser] validate a project picker modal or dropdown appears

test 4: Clearing project scope returns to "All" scope
- [browser] navigate to the assets page
- [browser] click "Project" scope to open project picker
- [browser] close or cancel the picker without selecting a project
- [browser] validate the scope reverts to "All"

test 5: Asset browser "All" scope shows records from all scopes
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/search?record_type=skill
- [api] validate HTTP response status is 200
- [api] validate data.results may contain records with any scope value

test 6: API — scope=user filter returns only user-scoped results
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/search?scope=user&record_type=skill
- [api] validate HTTP response status is 200
- [api] if data.results is non-empty: validate all results have scope="user"

test 7: API — scope=project with project_ids returns only project-scoped results
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/search?scope=project&project_ids=local&record_type=skill
- [api] validate HTTP response status is 200
- [api] validate data is an object (does not error)

test 8: Search filter panel — type filter shows record types as options
- [browser] navigate to {APP_URL}/dock/search
- [browser] click "Tools" to open filter panel
- [browser] validate the filter panel shows record type options (skill, agent, task, etc.)
- [browser] click "skill" type option
- [browser] validate the active filter shows skill is selected

test 9: Tools button toggles the filter panel on and off
- [browser] navigate to {APP_URL}/
- [browser] wait for page to load
- [browser] locate the button with data-testid="search-tools-btn"
- [browser] validate data-testid="search-filter-panel" is NOT visible initially
- [browser] click the Tools button
- [browser] validate data-testid="search-filter-panel" is now visible
- [browser] click the Tools button again
- [browser] validate data-testid="search-filter-panel" is no longer visible

test 10: Assets page scope filter All/User/Project buttons are clickable
- [browser] navigate to {APP_URL}/dock/assets
- [browser] wait for page to load
- [browser] locate the scope filter buttons (All, User, Project)
- [browser] click "User"
- [browser] validate "User" becomes active (highlighted/selected state)
- [browser] click "All"
- [browser] validate "All" becomes active again
