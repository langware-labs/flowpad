# Team Setup

Before spawning any teammates, use these templates.

## Creating the Team

```
TeamCreate(team_name="e2e-qa-cycle")   # for run/debug mode
TeamCreate(team_name="e2e-qa-analyze") # for analyze mode
```

## Spawning Teammates

**qa-tester** (up to 3 for run mode; 1 for debug/validate; one browser-capable tester by default unless truly isolated):

> **Browser ownership and per-test tab allocation are mandatory.** The rule is **one browser owner at a time per {Playwright MCP server process, Flowpad instance}**. A fresh tab prevents sequential task contamination but cannot isolate concurrent clients of one MCP process because actions use its currently selected page. Spawn one browser-capable tester whenever a queue can fall back to full `.md` MCP execution. More than one tester, up to the existing maximum of three, is allowed only when each owns a distinct headless isolated Playwright MCP process/context (never `--shared-browser-context`), a distinct named Flowpad backend/frontend with explicit `APP_URL` and `API_URL`, and a private Playwright/result output directory. `--isolated` does not make multiple callers of one process independent. If any boundary is shared, serialize. Bash/API-only work may overlap only when it neither writes/resets the same instance nor shares a runner output directory. See `.claude/skills/e2e-qa/agents/qa-tester.md` for the full lifecycle protocol.

```
Task(
  subagent_type="general-purpose",
  team_name="e2e-qa-cycle",
  name="qa-tester-1",  # qa-tester-2, qa-tester-3
  prompt="You are a qa-tester teammate on the e2e-qa-cycle team. Your name is qa-tester-1.
    Read your full instructions at .claude/skills/e2e-qa/agents/qa-tester.md.
    Environment: APP_URL=http://localhost:${VITE_PORT}, API_URL=http://localhost:${LOCAL_SERVER_PORT}
    Output dir: <output-dir>/<timestamp>/
    Browser allocation: You are the sole browser owner for your assigned Playwright MCP process and Flowpad instance. For EACH task you claim (Run:/Validate:/etc.), allocate a NEW browser tab via mcp__playwright__browser_tabs(action="new") and bind its returned index as MY_TASK_TAB_INDEX. Before EVERY browser action, call browser_tabs(action="select", index=MY_TASK_TAB_INDEX). Keep this tab open through the task's full lifecycle — Run → (any) Debug → Fix → re-Validate — so the same DOM state can be inspected across iterations. Close each scenario-created tab with browser_tabs(action="close", index=SCENARIO_TAB_INDEX), then, only when the task is completed (or marked skip-confirmed), close the task tab with browser_tabs(action="close", index=MY_TASK_TAB_INDEX). Then claim the next task and allocate a fresh tab. Never reuse another tester's tab or fall back to another browser MCP.
    Check TaskList and claim available 'Run:' or 'Validate:' tasks. Work through them until none remain.
    On shutdown_request, close any open task tabs before exiting.",
  run_in_background=true
)
```

**test_debugger** (debug mode; also parallel on first-time failures in run mode):
```
Task(
  subagent_type="general-purpose",
  team_name="e2e-qa-cycle",
  name="test_debugger",
  prompt="You are a test_debugger teammate on the e2e-qa-cycle team.
    Read your full instructions at .claude/skills/e2e-qa/agents/test_debugger.md.
    Debug log: .flow/skills/agentic-qa/debug_log.md
    Check TaskList and claim available 'Debug:' tasks.",
  run_in_background=true
)
```

**bug_fixer** (spawned after debugger produces RCA):
```
Task(
  subagent_type="general-purpose",
  team_name="e2e-qa-cycle",
  name="bug_fixer",
  prompt="You are a bug_fixer teammate on the e2e-qa-cycle team.
    Read your full instructions at .claude/skills/e2e-qa/agents/bug_fixer.md.
    Check TaskList and claim available 'Fix:' tasks.",
  run_in_background=true
)
```

**testing_analysis_expert** (analyze mode; parallel in debug mode for first-time failures):

When its task needs a skip challenge or live browser investigation, `testing_analysis_expert` takes the same exclusive browser-owner slot. Do not run it in parallel with a qa-tester on the same Playwright MCP process or Flowpad instance.
```
Task(
  subagent_type="general-purpose",
  team_name="e2e-qa-cycle",
  name="testing_analysis_expert",
  prompt="You are a testing_analysis_expert teammate on the e2e-qa-cycle team.
    Read your full instructions at .claude/skills/e2e-qa/agents/testing_analysis_expert.md.
    Output: .flow/skills/agentic-qa/coverage_analysis.md
    Check TaskList and claim available 'Analyze:' tasks.",
  run_in_background=true
)
```
