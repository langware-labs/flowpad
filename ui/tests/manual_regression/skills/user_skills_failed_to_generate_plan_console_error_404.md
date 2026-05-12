test 1: Skills list loads without 404 console errors (FLOWPAD-1665)
- navigate to {APP_URL}/dock/assets/list/skill
- wait 3 seconds for the assets list to load
- validate the assets list view is visible (BrowseableTree + AssetListView)
- look for any skill entry in the list
- check console for 404 errors (filter out the cross-cutting agent_hook/<id>/watch noise — that's its own ticket)
- validate no FLOWPAD-1665-shaped 404 (e.g. /api/v1/graph/plan/<id>) appeared in console

Note: Skills used to have a dedicated /dock/skills view; they have been
folded into the unified Assets browser at /dock/assets/list/skill. This
spec was updated for the new surface.
