test 1: Creating and viewing a skill shows no SkillParseError (FLOWPAD-1678)
- navigate to {APP_URL}/dock/assets/list/skill
- wait 3 seconds for the skills list to load
- validate the assets list view is visible (BrowseableTree + AssetListView)
- look for any "New Skill" / "Add" / create button in the assets list header
- if a create button exists, click it
- wait 2 seconds
- validate a new skill entry appears in the asset list (not a parse error)
- navigate to {APP_URL}/dock/home
- navigate back to {APP_URL}/dock/assets/list/skill
- validate the skills list loads correctly without "SkillParseError: Invalid SKILL.md format" errors
- check console for SkillParseError messages
- validate no SkillParseError appeared

Note: Skills used to have a dedicated /dock/skills view; they have been
folded into the unified Assets browser at /dock/assets/list/skill. This
spec was updated for the new surface.
