# Run Mode

When invoked with `run scenario <Y>` or `run [category]`:

Simple execution — no debug lifecycle unless failures occur.

1. **Verify test index**: Ensure `.flow/skills/agentic-qa/test_index.md` exists and is current.
2. **Build execution plan**: Scan the target scenarios (all, category, or single)
3. **Print the plan**:
   ```
   QA Cycle Plan
   ─────────────
   Scope: [all | category-name | scenario-name]
   Scenarios: N
   Categories: [list]
   Timestamp: YYYY-MM-DDTHH-MM-SS
   Output: ui/tests/manual_regression/_results/<timestamp>/
   ```
4. **Create the team**: `TeamCreate(team_name="e2e-qa-cycle")`
5. **Create tasks**: For each scenario, create a task via TaskCreate:
   ```
   TaskCreate(
     subject="Run: <category>/<scenario>",
     description="Execute scenario at <scenario-path>.
       Write JSON result to <output-dir>/<timestamp>/<category>--<scenario-name>.json.
       Playwright .md.ts exists: yes/no.
       APP_URL=http://localhost:${VITE_PORT}, API_URL=http://localhost:${LOCAL_SERVER_PORT}",
     activeForm="Running <category>/<scenario>"
   )
   ```
6. **Spawn testers**: Spawn up to 3 qa-tester teammates; each claims tasks autonomously.
7. **Monitor**: Periodically check TaskList until all "Run:" tasks are completed.
8. **Handle failures**:
   - **First-time failure** (no entry in `debug_log.md` for this scenario): spawn test_debugger + bug_fixer in parallel; also spawn testing_analysis_expert to check coverage
   - **Persistent failure** (entry exists in `debug_log.md`): spawn test_debugger + bug_fixer only
   - If debugger or fixer task returns FAIL: manager immediately reads their evidence and acts — attempt fix inline, escalate to the other, or flag; delegated task failures never end silently
   - After fix: create re-run task for tester (max 2 retries). After the 2nd failed retry, mark the scenario `flagged` per SKILL.md "Autonomous Run Policy" and move on — never stall the run waiting for guidance.
9. **Aggregate**: Read all JSON result files. Build cycle report conforming to `schemas/cycle-report.schema.json`.
10. **Generate HTML**: Read `templates/report.html`, inject cycle report data at `<!-- REPORT_DATA -->`, write to results directory. Open the report in the default browser (`open <path>` on macOS, `xdg-open <path>` on Linux) — do not start an HTTP server.
11. **Report summary**: Print the summary table and the report file path
12. **Shutdown**: Send `shutdown_request` to all teammates, then `TeamDelete`
