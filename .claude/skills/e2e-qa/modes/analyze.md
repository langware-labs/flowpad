# Analyze Mode

When invoked with `analyze [area/activity]`:

Coverage analysis → fully-specified test plan. No auto-authoring.

1. **Create the team**: `TeamCreate(team_name="e2e-qa-analyze")`
2. **Create analysis task**:
   ```
   TaskCreate(
     subject="Analyze: <area/activity or 'full coverage'>",
     description="Inspect all test types and produce coverage_analysis.md.
       Scope: tests/unit/, tests/api/, ui/tests/, ui/tests/manual_regression/
       Output: .flow/skills/agentic-qa/coverage_analysis.md",
     activeForm="Analyzing coverage"
   )
   ```
3. **Spawn testing_analysis_expert**: 1 teammate to perform the analysis
4. **Wait for completion**: Expert marks task complete and sends summary via SendMessage
5. **Present deliverable**: Show `coverage_analysis.md` as the actionable spec for the user to implement
6. **Shutdown**: Send `shutdown_request`, then `TeamDelete`
