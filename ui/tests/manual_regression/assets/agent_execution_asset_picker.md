---
id: 65739fe3-109f-53f8-89d7-9ffe08e9b1b4
---

# Agent Execution — Asset Picker (Asset Manager Popover)

## Summary
Verifies the Asset Manager popover that surfaces from the Settings gear of the
`EntityExecutionPanel` rendered at the bottom of an agent asset editor
(`AgentAssetEditor.tsx`). The picker uses `AssetManagerPopover` and lets the
user manage attached assets (skills/agents), open the Add mode, search, attach
a skill, then detach it. The footer's project selector must also render
(unlocked before the first message).

## Preconditions
- App is running at {APP_URL}
- Backend is running at {API_URL}
- At least one `agent` record and one `skill` record exist
  (verified via `GET {API_URL}/api/v1/search?record_type=agent&limit=1` and
  `record_type=skill`). If zero records, abort with a clear message — do NOT
  attempt to create records inside this scenario.

## Notes for the tester
- Do NOT send any prompt during this scenario — sending a message would lock
  the project selector. We test the unlocked state (no active process yet).
- The popover may take ~500ms to populate after first open (`useProcessAssets`
  refreshes on open). If the list is empty on first paint, wait up to 2s.
- After the scenario, leave the agent un-attached: detach anything you attach
  so the run is idempotent across reruns.

## Steps

### test 1: Settings gear opens the Asset Manager popover on an agent editor
- [browser] navigate to {APP_URL}/dock/assets/list/agent
- [browser] wait for page to load
- [browser] click the element with data-testid starts with "browseable-chevron-asset-type:agent:"
- [browser] wait for a treeitem at aria-level 2 to appear
- [browser] click the first agent row at aria-level 2
- [browser] wait for navigation
- [browser] validate the URL contains "/dock/assets/editor/agent/"
- [browser] validate the element with data-testid="agent-execution" is visible
- [browser] validate the element with data-testid="entity-execution-settings" is visible
- [browser] click the element with data-testid="entity-execution-settings"
- [browser] validate the element with data-testid="asset-manager-popover" is visible

### test 2: Default mode is List — filter, sort, and list panels render
- [browser] navigate to {APP_URL}/dock/assets/list/agent
- [browser] click the element with data-testid starts with "browseable-chevron-asset-type:agent:"
- [browser] click the first agent row at aria-level 2
- [browser] click the element with data-testid="entity-execution-settings"
- [browser] validate the element with data-testid="asset-manager-popover" is visible
- [browser] validate the element with data-testid="asset-manager-list-filter" is visible
- [browser] validate the element with data-testid="asset-manager-list-sort" is visible
- [browser] validate the element with data-testid="asset-manager-list" is visible
- [browser] validate the element with data-testid="asset-manager-add-menu" is visible
- [browser] validate the text "Assets" is visible inside the popover

### test 3: Add menu opens Add mode with search input
- [browser] navigate to {APP_URL}/dock/assets/list/agent
- [browser] click the element with data-testid starts with "browseable-chevron-asset-type:agent:"
- [browser] click the first agent row at aria-level 2
- [browser] click the element with data-testid="entity-execution-settings"
- [browser] click the element with data-testid="asset-manager-add-menu"
- [browser] click the element with data-testid="asset-manager-add-asset"
- [browser] validate the element with data-testid="asset-manager-search" is visible
- [browser] validate the element with data-testid="asset-manager-back" is visible
- [browser] validate the text "Add asset" is visible inside the popover

### test 4: Search narrows Add-mode candidates and Back returns to List
- [browser] navigate to {APP_URL}/dock/assets/list/agent
- [browser] click the element with data-testid starts with "browseable-chevron-asset-type:agent:"
- [browser] click the first agent row at aria-level 2
- [browser] click the element with data-testid="entity-execution-settings"
- [browser] click the element with data-testid="asset-manager-add-menu"
- [browser] click the element with data-testid="asset-manager-add-asset"
- [browser] wait for at least one element matching [data-testid^="asset-manager-add-row-"] to appear (up to 3s)
- [browser] read the rendered count of [data-testid^="asset-manager-add-row-"] as N0
- [browser] type "zzz_no_match_xyz_QA" into the element with data-testid="asset-manager-search"
- [browser] validate the text "No matches." is visible inside the popover
- [browser] clear the search input (select all and Backspace, or set value="")
- [browser] wait for the row count of [data-testid^="asset-manager-add-row-"] to be >= 1
- [browser] click the element with data-testid="asset-manager-back"
- [browser] validate the element with data-testid="asset-manager-list" is visible
- [browser] validate the text "Add asset" is NOT visible inside the popover

### test 5: Attach a skill — embedded row materializes with a detach button
# NOTE: the writable `embedded` row + detach button materialize only when the
# attached asset is NOT already a file-discovered source. project_dir/user_dir
# sources are read-only (no detach). In an env where every skill candidate is
# file-backed (the common local case), attaching one reflects on its existing
# read-only row and produces NO embedded duplicate — this test then `skip`s with
# that reason (no detachable writable row to assert). It passes only when a
# non-file-backed (embedded-producing) candidate exists.
- [browser] navigate to {APP_URL}/dock/assets/list/agent
- [browser] click the first element whose data-testid starts with "browseable-chevron-asset-type:agent:"
- [browser] click the first agent row at aria-level 2
- [browser] click the element with data-testid="entity-execution-settings"
- [browser] click the element with data-testid="asset-manager-add-menu"
- [browser] click the element with data-testid="asset-manager-add-asset"
- [browser] wait for at least one [data-testid^="asset-manager-add-row-skill-"] to appear (up to 3s)
- [browser] locate the FIRST add-row matching `[data-testid^="asset-manager-add-row-skill-"]` — call it ADD_ID
- [browser] derive TYPEID by stripping the prefix "asset-manager-add-row-" from ADD_ID
- [browser] click the input[type="checkbox"] inside ADD_ID
- [browser] wait up to 3s for the attach mutation to settle (an `embedded` descriptor materializes server-side)
- [browser] click the element with data-testid="asset-manager-back"
- [browser] validate the element with data-testid="asset-manager-list" is visible
- [browser] validate an element matching `[data-testid="asset-manager-row-<TYPEID>-embedded"]` is visible (the materialized embedded row). NOTE: `project_dir` and `user_dir` rows are read-only sources; the writable `embedded` row is what the attach materializes and where the detach button renders.
- [browser] validate the element with data-testid="asset-manager-detach-<TYPEID>" is visible (substitute TYPEID literally)
- [browser] [cleanup] click the element with data-testid="asset-manager-detach-<TYPEID>"
- [browser] wait 500ms
- [browser] validate the element with data-testid="asset-manager-detach-<TYPEID>" is NOT visible

### test 5b: Read-only descriptor row renders with a lock badge and no detach button
- [browser] navigate to {APP_URL}/dock/assets/list/agent
- [browser] click the first element whose data-testid starts with "browseable-chevron-asset-type:agent:"
- [browser] click the first agent row at aria-level 2
- [browser] click the element with data-testid="entity-execution-settings"
- [browser] click the element with data-testid="asset-manager-add-menu"
- [browser] click the element with data-testid="asset-manager-add-asset"
- [browser] locate the FIRST `[data-testid^="asset-manager-add-row-skill-"][data-read-only="true"]` — call it RO_ID
- [browser] if no such row exists, mark this test as `skip` (env has no read-only skill); otherwise:
- [browser] derive RO_TYPEID by stripping "asset-manager-add-row-" from RO_ID
- [browser] click the checkbox inside RO_ID
- [browser] wait 500ms
- [browser] click the element with data-testid="asset-manager-back"
- [browser] validate at least one `[data-testid^="asset-manager-row-<RO_TYPEID>-"][data-read-only="true"]` is visible (read-only row)
- [browser] validate an element matching `[data-testid^="asset-manager-readonly-<RO_TYPEID>-"]` is visible (lock badge)
- [browser] note: a writable `embedded` row may ALSO appear for the same TYPEID — that's where the detach button lives. The read-only row itself does NOT render a detach button (see AssetManagerPopover.tsx:606 — gated on `attached && !readOnly`).
- [browser] [cleanup] click the element with data-testid="asset-manager-detach-<RO_TYPEID>" (lives on the embedded row)

### test 6: Project selector renders unlocked in the footer (no active process)
- [browser] navigate to {APP_URL}/dock/assets/list/agent
- [browser] click the element with data-testid starts with "browseable-chevron-asset-type:agent:"
- [browser] click the first agent row at aria-level 2
- [browser] click the element with data-testid="entity-execution-settings"
- [browser] validate the element with data-testid="execution-settings-project-section" is visible
- [browser] validate the element with data-testid="execution-settings-project" is visible
- [browser] validate the element with data-testid="execution-settings-project" does NOT have attribute disabled
- [browser] validate the text "locked after first message" is NOT visible

### test 7: List filter narrows attached/listed rows
- [browser] navigate to {APP_URL}/dock/assets/list/agent
- [browser] click the element with data-testid starts with "browseable-chevron-asset-type:agent:"
- [browser] click the first agent row at aria-level 2
- [browser] click the element with data-testid="entity-execution-settings"
- [browser] type "zzz_no_match_xyz_QA" into the element with data-testid="asset-manager-list-filter"
- [browser] validate the text "No matches." is visible inside the element with data-testid="asset-manager-list"
- [browser] clear the list filter (select all and Backspace, or set value="")
- [browser] wait for the empty-state text "No matches." to disappear or the list to populate (up to 2s)

### test 8: Popover closes on outside click and reopens cleanly
- [browser] navigate to {APP_URL}/dock/assets/list/agent
- [browser] click the element with data-testid starts with "browseable-chevron-asset-type:agent:"
- [browser] click the first agent row at aria-level 2
- [browser] click the element with data-testid="entity-execution-settings"
- [browser] validate the element with data-testid="asset-manager-popover" is visible
- [browser] press Escape
- [browser] validate the element with data-testid="asset-manager-popover" is NOT visible
- [browser] click the element with data-testid="entity-execution-settings"
- [browser] validate the element with data-testid="asset-manager-popover" is visible
- [browser] validate no uncaught console errors appeared during the test (filter out 404 noise from `user-` typeid fetches as documented in the QA instructions)

## Pass Criteria
- [ ] Settings gear in the agent execution panel opens the Asset Manager popover
- [ ] Popover defaults to List mode with filter/sort/list panes
- [ ] Add menu → Add mode renders a searchable candidate list
- [ ] Search narrows candidates and "No matches." renders for an unmatchable query
- [ ] Back button returns to List mode
- [ ] Attaching a skill makes its row appear in List mode with a Detach button
- [ ] Detach removes the row
- [ ] Project selector renders in the footer and is unlocked before the first message
- [ ] List filter narrows visible rows
- [ ] Popover closes on Escape and reopens cleanly

## Coverage
- First-time coverage for `ExecutionSettingsPopover` × `AssetManagerPopover`
  on the agent execution surface. Not currently covered by Playwright .md.ts.
