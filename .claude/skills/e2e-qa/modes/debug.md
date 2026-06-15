# Debug Mode

When invoked with `debug test <scenario>`:

Full bug lifecycle for a specific failing scenario. Runs sequentially per issue.

**A. Tester confirms failure:**
1. Create task: `TaskCreate(subject="Run: <scenario>", description=<scenario details>)`
2. Spawn 1 qa-tester
3. Tester runs scenario → writes repro steps → SendMessage to manager with failure summary
4. Create task: `TaskCreate(subject="Debug: <scenario>", description=<repro steps + failure details>)`

**B. Parallel: check for coverage gaps (if first-time issue):**
- Create task: `TaskCreate(subject="Analyze: <scenario area>", description="Check if this is a first-time issue with no test coverage")`
- Spawn testing_analysis_expert in parallel (does not block fix cycle)
- Expert sends coverage recommendations to manager when done; manager incorporates into final report

**C. Debugger does RCA:**
- Spawn test_debugger to claim the "Debug:" task
- Debugger writes to `debug_log.md`, sends RCA + evidence to bug_fixer via SendMessage
- If debugger task returns FAIL or no verdict: manager immediately reads debug_log.md, confirms evidence, and either attempts inline RCA or flags the scenario with the partial evidence — delegated task failures never end silently
- Create task: `TaskCreate(subject="Fix: <scenario>", description=<RCA + evidence from debugger>)`

**D. Fixer ↔ Debugger iterate:**
- Spawn bug_fixer to claim the "Fix:" task
- Fixer challenges RCA, implements fix, sends to debugger for approval via SendMessage
- Debugger approves or rejects; fixer revises if needed (max 3 iterations)
- On approval: fixer SendMessage → tester "fix complete, please validate"

**E. Tester validates:**
- Create task: `TaskCreate(subject="Validate: <scenario>", description="Re-run after fix")`
- Tester re-runs, SendMessage result to manager

**F. Manager closes loop:**
- Update report with fix outcome + coverage recommendations
- Move to next issue if any
