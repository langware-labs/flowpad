---
id: 05470b72-3355-5d04-a371-e063bf58822e
---

test 1: Assets page is accessible via the Assets nav item
- [browser] navigate to {APP_URL}/
- [browser] wait for page to load (networkidle)
- [browser] click the "Assets" item in the collapsed sidebar (look for data-testid or label "Assets")
- [browser] validate the assets page or panel becomes visible

test 2: Asset type sidebar shows multiple asset types
- [browser] navigate to {APP_URL}/dock/assets
- [browser] wait for page to load (networkidle)
- [browser] validate a type sidebar is visible with at least one asset type listed (e.g. skill, agent, task, doc)

test 3: Clicking a type in the sidebar filters the list to that type
- [browser] navigate to {APP_URL}/dock/assets
- [browser] wait for page to load
- [browser] click a type item (e.g. "skill") in the type sidebar
- [browser] validate the asset list shows only records of that type
- [browser] validate the URL or active state of the sidebar reflects "skill" is selected

test 4: Asset list shows per-type columns (uid, name, status, source_path)
- [browser] navigate to {APP_URL}/dock/assets
- [browser] wait for page to load
- [browser] locate the data table or asset list
- [browser] validate column headers include name-like and status-like labels

test 5: Asset list shows source_path for skill records
- [browser] navigate to {APP_URL}/dock/assets
- [browser] wait for page to load
- [browser] select the "skill" type from the sidebar (if applicable)
- [browser] validate that at least one row shows a source_path value (a filesystem path like ~/.claude/skills/...)

test 6: Clicking an asset row opens the asset editor
- [browser] navigate to {APP_URL}/dock/assets
- [browser] wait for page to load
- [browser] click a row in the asset list
- [browser] validate an editor panel or detail view appears for that asset

test 7: Asset editor for a skill shows the skill name and description
- [browser] navigate to {APP_URL}/dock/assets/list/skill (or equivalent route)
- [browser] wait for page to load
- [browser] click the first skill row
- [browser] validate the editor shows a name field or header
- [browser] validate a description or markdown content area is visible

test 8: Back button from editor returns to the asset list
- [browser] navigate to an asset editor (e.g. {APP_URL}/dock/assets/editor/skill/...)
- [browser] click the back arrow or "←" button
- [browser] validate the asset list view is shown again
