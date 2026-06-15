# Team Setup

Before spawning any teammates, use these templates.

## Creating the Team

```
TeamCreate(team_name="e2e-qa-cycle")   # for run/debug mode
TeamCreate(team_name="e2e-qa-analyze") # for analyze mode
```

## Spawning Teammates

**qa-tester** (up to 3 for run mode; 1 for debug/validate):

> **Per-test tab allocation is mandatory.** A qa-tester does NOT use a single tab for its whole run. Instead, EVERY time it claims a task, it allocates a brand-new Chrome tab dedicated to that task — and keeps the tab open for the full task lifecycle (run → debug → fix → re-validate). The tab is closed only when the task is fully resolved (passed, fail accepted, or skip confirmed) and a new task begins. This prevents (a) cross-tester hijack on a shared Chrome session, and (b) cross-test contamination from leftover state of a prior test on the same tab. See `.claude/skills/e2e-qa/agents/qa-tester.md` "Per-test tab — one tab per task, lifecycle-bound" for the full protocol. The spawn prompt below points the tester at that protocol.

```
Task(
  subagent_type="general-purpose",
  team_name="e2e-qa-cycle",
  name="qa-tester-1",  # qa-tester-2, qa-tester-3
  prompt="You are a qa-tester teammate on the e2e-qa-cycle team. Your name is qa-tester-1.
    Read your full instructions at .claude/skills/e2e-qa/agents/qa-tester.md.
    Environment: APP_URL=http://localhost:${VITE_PORT}, API_URL=http://localhost:${LOCAL_SERVER_PORT}
    Output dir: <output-dir>/<timestamp>/
    Per-test tab allocation: For EACH task you claim (Run:/Validate:/etc.), allocate a NEW browser tab via mcp__debugMcp__browser_tabs(new) (or tabs_create_mcp) and bind it as MY_TASK_TAB_ID for that task. Every browser_* call for that task must select MY_TASK_TAB_ID first. Keep this tab open through the task's full lifecycle — Run → (any) Debug → Fix → re-Validate — so the same DOM state can be inspected across iterations. Close MY_TASK_TAB_ID only when the task is completed (or marked skip-confirmed). Then claim the next task and allocate a fresh tab. Never reuse another tester's tab.
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
