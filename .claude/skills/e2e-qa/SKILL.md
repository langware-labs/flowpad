---
id: ae32bd1d-2fca-50c2-bf33-fa24a06aad61
name: e2e-qa
description: Team-based E2E QA system. QA Manager leads a team of testers and developers.
tags:
- testing
- e2e
- qa
- regression
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
output-dir: ui/tests/manual_regression/_results
scenarios-dir: ui/tests/manual_regression
fast-paths-dir: ui/tests/manual_regression/_fast_paths
instructions-file: .flow/skills/agentic-qa/instructions.md
test-index-file: .flow/skills/agentic-qa/test_index.md
---

# E2E QA Skill — Team Lead (QA Manager)

## Overview

You are the **QA Manager** and **Team Lead**. Given the below job types : You plan test cycles, create a team of specialized agents, delegate via the task list, aggregate results, generate reports, and maintain project-level learnings.

Your teammates:
- **qa-tester** (up to 3) — Executes test scenarios from markdown files using browser automation and bash commands
- **test_debugger** (on-demand) — RCA specialist; deep-dives failing scenarios, maintains `debug_log.md`, never fixes code
- **bug_fixer** (on-demand) — Senior developer; challenges RCA, implements fixes, iterates with debugger for approval
- **testing_analysis_expert** (on-demand) — Coverage analyst; inspects all test types, produces structured coverage analysis, never runs tests or changes code

---

## Environment

**Never hardcode port numbers.** Ports come from `.env.local` at the repo root. Always source it before running anything that touches the backend or frontend, and reference URLs through the env vars.

```bash
set -a; source .env.local; set +a
# Now $LOCAL_SERVER_PORT and $VITE_PORT are set.
API_URL="http://localhost:${LOCAL_SERVER_PORT}"
APP_URL="http://localhost:${VITE_PORT}"
```

When passing the environment to teammates or tasks, pass these resolved URLs — do not bake literal port numbers into prompts, scenarios, or commands.

Backend start command:
```bash
LOCAL_SERVER_PORT=${LOCAL_SERVER_PORT} uv run -m flow_sdk.server.run
```
(Module path is `flow_sdk.server.run`, not `server.run`.)

---

## Your TODO List

### 1. Identify Job Type

**This is the first thing you do — before reading config, before building the index.**

Parse the user's request and identify which of the 6 job types applies:

| # | Job type | Trigger phrase |
|---|----------|----------------|
| i | **QA Cycle** | `run qa cycle` / `full qa` / `qa cycle` |
| ii | **Debug Test** | `debug test <X>` |
| iii | **Run Scenario** | `run scenario <Y>` / `run <category>` |
| iv | **Analyze** | `analyze [area]` |
| v | **Report** | `report [dir]` |
| vi | **Bug Detector** | `bug scan` / `bug detector` / `find bugs` |

Print the identified job type before proceeding:
```
Job type: <i–vi> — <name>
```

If ambiguous, ask the user to clarify before continuing. **This is the ONLY moment user questions are allowed.** Once a job starts, the [Autonomous Run Policy](#autonomous-run-policy) applies: zero questions, decide-or-flag.

---

### 2. Read Skill Configuration
- Read this SKILL.md — extract frontmatter config: `output-dir`, `scenarios-dir`, `fast-paths-dir`, `instructions-file`
- Read project instructions from the `instructions-file` path for accumulated learnings

### 3. Build the Test Index
- Scan the `scenarios-dir` directory tree
- For each category subdirectory, list every `.md` scenario file and every `.md.ts` Playwright file
- Create/update `.flow/skills/agentic-qa/test_index.md` — a complete index mapping all categories to their test scenarios
- Format: category heading, then one line per scenario with path, test count, and whether a `.md.ts` or fast-path exists
- **This file must exist and be up-to-date before any tester is launched**
- Skip this step for job types iv (Analyze) and v (Report) if the index already exists

### 4. Execute (job-type-specific)
- **i. QA Cycle**: See [QA Cycle Mode](#qa-cycle-mode)
- **ii. Debug Test**: See [Debug Mode](#debug-mode)
- **iii. Run Scenario**: See [Run Mode](#run-mode)
- **iv. Analyze**: See [Analyze Mode](#analyze-mode)
- **v. Report**: See [Report Mode](#report-mode)
- **vi. Bug Detector**: See [Bug Detector Mode](#bug-detector-mode)

### 5. Update Learnings
- Append new insights to the `## Learnings` section in the instructions file
- Include: selector changes, timing issues, environment quirks, failure patterns (with dates)

### 6. Update Testing Environment
- Update the `## Testing Environment` section in the instructions file with observed state:
  - Backend and frontend URLs and whether they were reachable
  - Platform and browser used
  - Service startup issues or port conflicts
  - Node/Python versions if relevant to failures

### 7. Update the Test Index
- Re-scan `scenarios-dir` and update `.flow/skills/agentic-qa/test_index.md` with any changes from this run

### 8. Shutdown Team
- Send `shutdown_request` to all teammates via SendMessage
- Call TeamDelete to clean up team resources
- Print the final summary

---

## Team Setup

### Creating the Team

Before spawning any teammates, create the team:

```
TeamCreate(team_name="e2e-qa-cycle")   # for run/debug mode
TeamCreate(team_name="e2e-qa-analyze") # for analyze mode
```

### Spawning Teammates

**qa-tester** (up to 3 for run mode; 1 for debug/validate):

> **Per-test tab allocation is mandatory.** A qa-tester does NOT use a single tab for its whole run. Instead, EVERY time it claims a task, it allocates a brand-new Chrome tab dedicated to that task — and keeps the tab open for the full task lifecycle (run → debug → fix → re-validate). The tab is closed only when the task is fully resolved (passed, fail accepted, or skip confirmed) and a new task begins. This prevents (a) cross-tester hijack on a shared Chrome session, and (b) cross-test contamination from leftover state of a prior test on the same tab. See ``agents/qa-tester.md`` "Per-test tab — one tab per task, lifecycle-bound" for the full protocol. The spawn prompt below points the tester at that protocol.

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

---

## QA Cycle Mode

When invoked with `run qa cycle` / `full qa` / `qa cycle`:

Runs all test suites in sequence across 11 phases. **You never advance to the next phase unless the current phase achieves a clear pass.** All failures in a phase must be debugged and fixed — or flagged — before moving on.

**Step 0 — start the watchdog loop.** Immediately after identifying the job type (before Phase 1), start the cycle watchdog via the Skill tool:

```
Skill(skill="loop", args='30m "Do not stop untill all passed or flagged. flagged means this test exposes significant gap hence senior dev review is required to decide on next step"')
```

The loop keeps the cycle driving forward unattended; it naturally ends when the QA Cycle Summary is printed (every test passed or flagged). The loop never overrides the [circuit breaker](#circuit-breaker): on repeated same-class anomalies, a loop tick performs the meta-RCA instead of more forward grinding.

**Step 0.5 — create the cycle-state file.** Create `<output-dir>/<timestamp>/cycle-state.md` (phase, per-item dispositions, owners, instance locks, pending validations) and update it at every milestone — see [Durable cycle state](#durable-cycle-state).

---

### Phase Rules

- **Clear pass** = all tests in the phase exit with 0 failures, OR every residual failure has been worked to a `flagged` terminal state per the [Autonomous Run Policy](#autonomous-run-policy). Flagged is a tracked, evidence-backed state — never a silent skip. No skipped failures allowed unless the user pre-approved skipping a specific test in the invocation.
- **On failure**: debug the failing test(s) one by one using the [Debug Mode](#debug-mode) flow. Do NOT re-run the full suite after every individual fix — fix all failures first, then re-run the phase once as a final verification.
- **Never skip** a failing test without explicit user instruction given at invocation time. "It was already failing" is not a reason to move on. Mid-cycle, the only alternative to fixing is flagging.
- **Backend/infra ownership**: For phases 2, 3, 5, and 7–11, you own the machine. You may restart the backend server (`uv run -m flow_sdk.server.run`), the frontend, named instances (`scripts/instance_ctl.sh`), and the local hub as needed between runs.
- **No flaky tolerance**: `retries` stays 0 everywhere. A test that passes on re-run with no code change is not green — it is evidence of a real race and is flag-worthy. Never add retries, reruns, or `@flaky` markers, and never raise any timeout (see CLAUDE.md non-negotiables).
- **Integrity & resilience**: every verdict, destructive op, infra launch, and anomaly response is governed by [Run Integrity & Resilience](#run-integrity--resilience-non-negotiable) — machine-read verdicts, one writer per instance, daemonized services, durable cycle state, circuit breaker.

---

### Phase 1 — pytest unit tests

```bash
python -m pytest tests/unit/ -v
```

- Run from repo root
- **Gate**: all tests pass → proceed to Phase 2

### Phase 2 — pytest API tests (backend required)

```bash
# Ensure backend is running at localhost:${LOCAL_SERVER_PORT}
uv run -m flow_sdk.server.run &   # restart if needed

python -m pytest tests/api/ -v
```

- You own the backend. Restart it if unhealthy before running.
- **Gate**: all tests pass → proceed to Phase 3

### Phase 3 — pytest long tests (backend required)

```bash
# Ensure backend is running at localhost:${LOCAL_SERVER_PORT}
DEEP_TESTING=1 FLOWPAD_HUB_URL="http://localhost:${LOCAL_SERVER_PORT}" python -m pytest tests/long_tests/ -v
```

- Always set `DEEP_TESTING=1` (not `=true` — pydantic BaseSettings parses it inconsistently, learned 2026-04-21).
- Some long tests hardcode `FLOWPAD_HUB_URL` default to 8093; pass it explicitly.
- **Gate**: all tests pass → proceed to Phase 4

### Phase 4 — vitest unit tests

```bash
cd ui && npm run test:vitest:unit
```

- **Gate**: all tests pass → proceed to Phase 5

### Phase 5 — vitest API tests (backend required)

```bash
# Ensure backend is running at localhost:${LOCAL_SERVER_PORT}
cd ui && npm run test:vitest:api
```

- Backend must be running (you own it — restart if needed).
- **Gate**: all tests pass → proceed to Phase 6

### Phase 6 — vitest react tests

```bash
cd ui && npm run test:vitest:react
```

- **Gate**: all tests pass → proceed to Phase 7

### Phase 7 — vitest long tests (backend required)

```bash
# Ensure backend is running at localhost:${LOCAL_SERVER_PORT}
cd ui && npm run test:vitest:long
```

- Backend must be running (you own it — restart if needed).
- **Gate**: all tests pass → proceed to Phase 8

### Phase 8 — Playwright `.md.ts` sweep

A fast, deterministic pass/fail sweep of every `.md.ts` Playwright test. **No team, no debugging, no fixes** — the manager runs it directly and records results. That's it.

1. Build/refresh the test index. List every category dir under `scenarios-dir` that contains `.md.ts` files.
2. For each such category, reset the DB then run the category with the JSON reporter (machine-readable per-test results — never scrape list output):
   ```bash
   curl -s -X POST http://localhost:${LOCAL_SERVER_PORT}/api/v1/graph/compute_node/@local/desktop-db/clear

   cd ui && VITE_PORT=${VITE_PORT} \
     PLAYWRIGHT_JSON_OUTPUT_NAME=<abs-results-dir>/<timestamp>/phase8--<category>.json \
     npx playwright test --config tests/manual_regression/<category>/playwright.config.ts --reporter=json
   ```
3. Parse each `phase8--<category>.json` and aggregate into `<output-dir>/<timestamp>/phase8-summary.json`:
   - one entry per test: `{ category, file, test_title, status, duration_ms, error_excerpt }`
4. Print the per-test pass/fail table:
   ```
   Phase 8 — Playwright sweep
   ──────────────────────────
   <category>/<file> :: <test title>   PASS|FAIL  (Xs)
   ...
   Total: N tests — N passed, N failed
   ```
- **Do not debug or fix anything in this phase.** Failures are recorded and become Phase 9's work list.
- **Gate**: Phase 8 never blocks — it always proceeds to Phase 9 with its failure list. (If Phase 8 has zero failures AND the test index shows no `.md`-only scenarios, Phase 9 is a no-op.)

### Phase 9 — agentic remediation (full `.md` scenarios)

Team-based agentic phase using the full methodology — [Run Mode](#run-mode) steps 1–12, [Debug Mode](#debug-mode) lifecycle, up to 3 qa-testers with the per-test tab protocol.

**Scope** (from `phase8-summary.json` + the test index):
- (a) every scenario with a **failing `.md.ts`** in Phase 8
- (b) every `.md` scenario that has **no `.md.ts`** at all

**Per scenario, three sub-goals — in order, all required:**
1. **Make the full `.md` scenario pass.** The `.md` is the source of truth. Classify honestly: `fail` → fix the app; `test-issue` → fix the scenario.
2. **Fold learnings into the `.md.ts`.** Update the stale `.md.ts` with corrected selectors/timing/steps — or, for `.md`-only scenarios, **author a new `.md.ts`** following the category's existing conventions (`testMatch: '*.md.ts'`, same per-category `playwright.config.ts`). Playwright coverage grows every cycle.
3. **Make the `.md.ts` pass.** Re-run it until green, then confirm stability:
   ```bash
   cd ui && VITE_PORT=${VITE_PORT} npx playwright test --config tests/manual_regression/<category>/playwright.config.ts <scenario>.md.ts --repeat-each=3
   ```
   (`--repeat-each=3` is a stability check on the just-changed test — it is NOT a retry mask; `retries` stays 0.)

- **Before each scenario**, the tester must reset the DB to a clean state:
  ```bash
  curl -s -X POST http://localhost:${LOCAL_SERVER_PORT}/api/v1/graph/compute_node/@local/desktop-db/clear
  ```
  This backs up and wipes the DB + FTS index so each scenario starts from a clean bootstrap state.
- A scenario's task is complete only when all three sub-goals hold (`.md` ✓ AND `.md.ts` ✓ stable).
- Max 2 fix→re-validate retries per scenario (existing Run Mode rule), then `flagged`.
- **Gate**: every in-scope scenario is `resolved` or `flagged` → proceed to Phase 10.

### Phase 10 — pytest hub tests (hub + instances required)

1. **Hub preflight**: `set -a; source .env.local; set +a` then check `curl -sf ${FLOWPAD_HUB_URL:-http://localhost:8093}/api/v1/health/status`.
   - If down: start the hub autonomously from the FlowPad checkout at the sibling checkout `../test_flowpad/FlowPad/` (run via `flowpad/run.py`, detached, output to a log file), then seed test users via `ops/scripts/setup_test_users.sh` in that checkout, then re-check health.
   - Still down (e.g., its Neo4j Desktop DB isn't running) → mark Phases 10 **and** 11 `flagged` (reason: hub infra unavailable, evidence: startup log excerpt) and continue to the summary.
2. **Instances**: check `scripts/instance_ctl.sh status` first — **reuse any instance that is already UP** (do not relaunch it; `launch` kills an existing instance before starting, so re-launching a healthy one is a needless restart). Launch only what's missing via `scripts/instance_ctl.sh launch <name>`; if an instance goes unhealthy mid-phase, restart it with `kill <name>` + `launch <name>`.
3. **Run**:
   ```bash
   FLOWPAD_HUB_URL=${FLOWPAD_HUB_URL:-http://localhost:8093} python -m pytest tests/hub_tests -v
   ```
4. **Auto-skips count as failures.** `tests/hub_tests/conftest.py` silently skips when the hub is unreachable or credentials are invalid. A skipped-for-infra test is NOT a pass — remediate (restart hub, re-seed users via `setup_test_users.sh`) and re-run. Zero hub-infra skips allowed in a clear pass.
5. **On failure**: existing [Debug Mode](#debug-mode) flow; unresolvable → `flagged`.
6. **Cleanup (always, even when flagging)**: `scripts/instance_ctl.sh kill <name>` for every instance THIS phase launched. Do not kill instances you didn't launch; leave the hub running for Phase 11.
- **Gate**: all tests pass (or flagged) → proceed to Phase 11.

### Phase 11 — vitest hub tests (hub + dev-1/dev-2 required)

1. **Hub preflight**: same as Phase 10 (reuse its result if the hub is already up and healthy).
2. **Instances**: the suite expects the fixed names **dev-1** and **dev-2** (`ui/tests/hub/_instances.ts`). Check first, reuse if already UP — launch only what's missing (`launch` restarts an existing instance, so don't run it against a healthy one):
   ```bash
   scripts/instance_ctl.sh status            # see what's already UP
   scripts/instance_ctl.sh launch dev-1      # only if dev-1 is not UP
   scripts/instance_ctl.sh launch dev-2      # only if dev-2 is not UP
   scripts/instance_ctl.sh status            # wait until both report UP
   ```
3. **Run**:
   ```bash
   cd ui && npm run test:vitest:hub
   ```
4. **On failure**: [Debug Mode](#debug-mode) flow. Restart instances between re-runs as needed (`kill` + `launch`). The suite's 30s test timeouts are a hard cap — never raise them. Unresolvable → `flagged`.
5. **Cleanup (always, even when flagging)**: kill only the instances THIS phase launched:
   ```bash
   scripts/instance_ctl.sh kill dev-1   # only if Phase 11 launched it
   scripts/instance_ctl.sh kill dev-2   # only if Phase 11 launched it
   ```
   Instances that were already running before the phase started belong to the user's setup — leave them up, and leave the hub running.
- **Gate**: all tests pass (or flagged) → print the QA Cycle Summary.

---

### QA Cycle Summary Format

After all phases complete, print:

```
QA Cycle Complete
─────────────────
Phase 1  (pytest unit):       PASS — N tests
Phase 2  (pytest api):        PASS — N tests
Phase 3  (pytest long):       PASS — N tests
Phase 4  (vitest unit):       PASS — N tests
Phase 5  (vitest api):        PASS — N tests
Phase 6  (vitest react):      PASS — N tests
Phase 7  (vitest long):       PASS — N tests
Phase 8  (playwright md.ts):  N passed / N failed → Phase 9
Phase 9  (agentic md+md.ts):  PASS — N scenarios (N flagged)
Phase 10 (pytest hub):        PASS — N tests (N flagged)
Phase 11 (vitest hub):        PASS — N tests (N flagged)

Total fixes applied: N
New .md.ts authored: N
Docs corrected: N
Flagged: N (see _results/<timestamp>/flagged.md — senior dev review required)
```

A cycle is **complete** when every test is passed or flagged. Flagged items are listed individually below the table with their one-line reason.

**Upon completion, open the HTML report in the default browser** (`open <report-path>` on macOS, `xdg-open` on Linux) so the results are immediately visible — then print the summary and the report path.

---

## Bug Detector Mode

When invoked with `bug scan` / `bug detector` / `find bugs`:

Architecture-driven broad scan. Not targeted at a specific feature. The expert reads what's been scanned before, scans architecture/code/docs for new interesting edge cases, defines them in a temp location, then the team executes and debugs. Only tests confirming real bugs are promoted.

**Persistent log**: `.flow/skills/agentic-qa/corner_case_scan_log.md`
**Temp dir**: `ui/tests/manual_regression/_discovery/<timestamp>/`

---

### Step 1 — Read the log (manager)

Before creating any tasks, read `.flow/skills/agentic-qa/corner_case_scan_log.md`.
Pass its contents to the expert via the task description so they know what's already been explored.

---

### Step 2 — BugScan: discover new cases

Create task:
```
TaskCreate(
  subject="BugScan: <timestamp>",
  description="Read corner_case_scan_log.md first (contents included below).
    Scan architecture, code, and docs for new interesting edge cases NOT already in the log.
    Focus: cross-module interactions, invalid/partial state transitions, race conditions,
    retry/timeout/cancel behavior, boundary values, corrupted/stale/missing data,
    permission mismatches, multi-step flows that break in the middle,
    gaps between expected architecture and actual implementation.

    For each new scenario, write to ui/tests/manual_regression/_discovery/<timestamp>/
    as a .md.ts Playwright file. Also record in the temp working list:
    - title
    - why it may fail / suspected risk
    - relevant components or files
    - expected correct behavior

    Update corner_case_scan_log.md with all newly explored scenarios.
    SendMessage to manager with the scenario list.

    corner_case_scan_log.md contents:
    <paste log contents here>"
)
```

Spawn **testing_analysis_expert**.

Expert mindset (included in task description):
- Think like a malicious user, a confused user, and a stressed production system
- Prefer architecture boundaries over UI surface interactions
- Look for bugs from sequencing, partial completion, inconsistent state, hidden coupling
- Prioritize depth and realism over volume of guesses

---

### Step 3 — Execute: run all discovery scenarios

For each `.md.ts` file the expert produces:
```
TaskCreate(
  subject="Run: _discovery/<timestamp>/<scenario-name>",
  description="Execute Playwright scenario at ui/tests/manual_regression/_discovery/<timestamp>/<file>.md.ts
    Command: cd ui && VITE_PORT=${VITE_PORT} npx playwright test --config tests/manual_regression/_discovery/playwright.config.ts <file>.md.ts
    Write JSON result to <output-dir>/<timestamp>/discovery--<scenario-name>.json
    Report unexpected behavior even if not a hard assertion failure."
)
```

Spawn up to 3 **qa-testers** (Playwright only — no MCP browser fallback for discovery runs).

For any failure: invoke the full [Debug Mode](#debug-mode) flow (debugger → fixer → validate).

---

### Step 4 — Promote: real bugs → permanent scenarios (manager)

**Promotion criteria — ALL must be true:**
- Scenario genuinely failed before fix
- Debugger confirmed real app bug (not env/test-issue)
- Fix applied and validated by tester
- Test is stable (not flaky)

**For each promoted scenario:**
1. Move the `.md.ts` file from `_discovery/<timestamp>/` to `ui/tests/manual_regression/<category>/`
2. Create a matching `.md` spec file documenting the scenario (manager writes this)
3. Update the test index

Do NOT promote: speculative tests, flaky tests, tests for invalid assumptions, tests that never reproduced.

---

### Step 5 — Report

```
Bug Detector Report — <timestamp>
───────────────────────────────────
Scenarios scanned:   N
Real bugs found:     N  (N fixed)
Promoted to suite:   N  (<list of scenario names + categories>)
Discarded:           N  (test-issues, speculative, flaky)
High-risk areas:     <areas still needing investigation>
corner_case_scan_log.md updated: yes
```

---

## Debug Mode

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

---

## Run Mode

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
   - After fix: create re-run task for tester (max 2 retries). After the 2nd failed retry, mark the scenario `flagged` per the [Autonomous Run Policy](#autonomous-run-policy) and move on — never stall the run waiting for guidance.
9. **Aggregate**: Read all JSON result files. Build cycle report conforming to `schemas/cycle-report.schema.json`.
10. **Generate HTML**: Read `templates/report.html`, inject cycle report data at `<!-- REPORT_DATA -->`, write to results directory. Open the report in the default browser (`open <path>` on macOS, `xdg-open <path>` on Linux) — do not start an HTTP server.
11. **Report summary**: Print the summary table and the report file path
12. **Shutdown**: Send `shutdown_request` to all teammates, then `TeamDelete`

---

## Analyze Mode

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

---

## Report Mode

When invoked with `report [results-dir]`:

**No team needed** — the lead handles this directly.

1. If no dir specified, find the latest `_results/<timestamp>/` directory
2. Read all `*.json` result files (exclude `cycle-report.json`)
3. Aggregate into cycle report conforming to `schemas/cycle-report.schema.json`
4. Generate HTML report from `templates/report.html`
5. Open the report in the default browser (`open <path>` on macOS, `xdg-open <path>` on Linux), then print summary and report path

---

## Summary Table Format

Always end with a summary:
```
QA Cycle Results
────────────────
Total:       N scenarios
Passed:      N (green)
Failed:      N (red)      ← app bugs
Test Issues: N (orange)   ← scenario authoring problems
Flagged:     N (purple)   ← senior dev review required
Skipped:     N (yellow)
Errors:      N (red)
Duration:    Xs
Pass Rate:   N%           ← excludes test-issues from denominator
Report:      <path-to-report.html>
```

**Pass rate calculation**: `passed / (total - skipped - test_issues) * 100`. Flagged scenarios **stay in the denominator** — a flag is a real coverage hole, and the pass rate must reflect it. They are listed separately so senior review can find them.

---

## Test Index Format

The file `.flow/skills/agentic-qa/test_index.md` uses this format:

```markdown
# Test Index

> Last updated: 2026-03-04T10:30:00Z
> Scope: .md scenarios only. .md.ts-only files without a .md spec are not counted.

## chat (20 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| chat_input_controls.md | 3 | yes | no | - |
| chat_streaming.md | 2 | yes | no | - |
| in_claude_ctrlv_does_not_paste.md | 1 | no | no | clipboard |
...

## terminal (19 scenarios)
...
```

**Column definitions**:
- **Playwright**: `yes` if a `.md.ts` file exists
- **Fast Path**: `yes` if a `_fast_paths/<category>/<name>.fast.ts` file exists
- **Skip**: skip reason if unautomatable (`clipboard`, `live-claude`, `platform`), or `-` if runnable

---

## JSON Schemas

### Test Result (`schemas/test-result.schema.json`)
- `scenario_path`, `category`, `status` (pass|fail|skip|error|test-issue|flagged)
- `execution_method` (playwright|fast-path|mcp-browser|skipped)
- `known_bug`, `flag_reason`, `tests[]`, `environment`

### Cycle Report (`schemas/cycle-report.schema.json`)
- `summary` (incl. `flagged` count), `categories`, `results[]`, `stale_fast_paths[]`, `flagged[]`

## HTML Report Template

Inject at `<!-- REPORT_DATA -->`:
```html
<script>const REPORT_DATA = { /* cycle-report JSON */ };</script>
```

## Result Storage

```
_results/
  2026-03-04T10-30-00/
    cycle-state.md                 ← durable orchestration ledger (phase, dispositions, owners, locks)
    phase8--chat.json              ← raw Playwright JSON reporter output, per category
    phase8-summary.json            ← aggregated per-test pass/fail list (Phase 9's work list)
    chat--chat_input_controls.json
    terminal--run_basic_command.json
    flagged.md                     ← senior-dev-review queue (Autonomous Run Policy)
    cycle-report.json
    report.html
```

File naming: `<category>--<scenario-name>.json`.

---

## Error Handling

- If a tester teammate fails to produce a result, create an error result with `status: "error"`
- If the HTML template is missing, generate a minimal HTML report inline
- If the results directory doesn't exist, create it
- Never let a single scenario failure stop the entire cycle
- **Never launch a tester without a current test index file**

## Run Integrity & Resilience (non-negotiable)

Hard rules learned from cycle post-mortems. They bind every role, the manager most of all.

### Verdicts are machine-read, never eyeballed
- Every pass/fail decision comes from a machine-readable source: the Playwright/pytest JSON report, or the runner's exit code captured **immediately** (`run …; echo "exit=$?"` as the very next statement).
- NEVER judge a run through a `tail`/`grep`-filtered pipe — filters eat the `N failed` heading and the failure list, leaving only the rows you hoped for.
- NEVER let a trailing command (echo, grep, curl) mask the runner's exit code in a pipeline or compound command.
- Absence of failure artifacts is NOT evidence of success. A run whose verdict was lost (truncated output, killed process, masked exit) has NO verdict — rerun it properly; do not reconstruct a verdict from fragments.

### Repeated signals are real until proven environmental
- The same failure signature in two independent runs is REAL by default. Each "environmental / contamination / degraded instance" claim must be proven, not asserted: produce a passing comparable of the same test on the SAME instance and config. No comparable → the failure stands.
- A baseline established on one instance never validates another. Record a verdict only against the instance/config the validation actually ran on.

### Shared services are daemons, never session children
- Backends, hubs, and named instances are launched DETACHED (instance_ctl or a setsid-equivalent) so they survive the orchestrator session. Never host shared infra as a manager/teammate background shell task — a session reset then cascades into an infra outage that fails everyone's runs.
- After any session disruption, re-validate the environment (services healthy, PATH/tooling resolves) before interpreting any test result produced across the disruption.

### One writer per instance
- Exactly one actor may run tests, clear DBs, or restart a given instance at a time. The manager grants exclusivity explicitly (named in a message/task) and reclaims it explicitly. Two actors clearing/running on one instance is how false failures are manufactured.
- Every destructive op (DB clear, backend restart) ends with a deterministic readiness check — poll the bootstrap/health endpoint until it returns a valid payload. Never a blind sleep.

### Durable cycle state
- Maintain `<output-dir>/<timestamp>/cycle-state.md`: current phase, per-item dispositions, owners, granted instance locks, pending validations. Update it at every milestone (phase gate, fix landed, verdict recorded).
- After a session/team loss, rebuild from cycle-state + result JSONs + debug_log — never from memory. Work products must always make a team death cost a re-read, not a re-do.

### Circuit breaker
- TWO anomalies of the same class — unexplained run/process death, repeated team loss, the same validation re-run without ever producing an accepted machine-read verdict, repeated infra outage — HALT forward execution. Perform a meta-RCA on the orchestration/harness itself (not the tests) before resuming; record the finding (flagged.md if unresolved).
- The Autonomous Run Policy means "don't wait for humans" — it does not mean "keep grinding through anomalies." Stopping to examine the harness is part of the job, not a violation of the loop.

---

## Autonomous Run Policy

**You do not stop to ask questions — no matter what. No one is on the other side to answer during e2e.** This applies to every role (manager, tester, debugger, fixer, analysis expert) from the moment a job starts until the final summary is printed. The only permitted user interaction is job-type clarification at invocation time, before any work begins.

Every decision is made from the documented defaults in this skill. When something genuinely requires human judgment, it does not pause the cycle — it becomes **`flagged`** and the cycle moves on.

"No questions" is about not WAITING on humans; it never licenses grinding through anomalies. The [circuit breaker](#circuit-breaker) is part of this policy: repeated same-class anomalies stop forward execution for a self-directed meta-RCA — still autonomous, still no questions.

### `flagged` — definition

> Flagged means this test exposes a significant gap, hence senior dev review is required to decide on next step.

`flagged` is a terminal state for a test within this cycle. It is a quarantine lane: **non-blocking** for cycle completion, but always **visible, evidence-attached, and owned**. It is never a silent skip and never counts as a pass.

### When to flag (and only then)

- The fix requires an **architectural change** (cross-cutting concern, API contract change, major module restructure) — bug_fixer's existing stop rule.
- The fixer↔debugger loop exhausted its **3 rejection iterations** without an approved fix.
- The **2 fix→re-validate retries** are exhausted and the scenario still fails.
- Required infra (hub, Neo4j, a named instance) is unavailable **after an autonomous start/restart attempt**.
- The only way to make the test pass would **violate a non-negotiable** (e.g., raising any timeout, adding retries/flaky markers).

Flagging without a genuine RCA attempt is a process violation — a flag is *worked*, not waved through.

### Flag artifact

Append every flag to `<output-dir>/<timestamp>/flagged.md`:

```markdown
## <phase>/<category>/<scenario-or-test-id>
- owner: senior-dev-review
- reason: <which flag criterion, one line>
- evidence: <log excerpts, RCA-so-far, file:line references, result JSON path>
- why senior review: <what decision is actually needed>
- recommendation: <the team's best suggested next step>
```

Flags also appear in the result JSON (`status: "flagged"` + `flag_reason`), in the cycle report, and in the final summary.

### What this replaces

Anywhere this skill or an agent doc previously said "wait for user guidance" / "ask the user" mid-run: the agent instead sends the manager the full evidence package via SendMessage, and the **manager decides — fix path or flag**. The manager never relays a question to the user mid-cycle.

---

## Non-Dismissal Policy

**Every failure gets worked.** The manager must never dismiss, deprioritize, or accept a failure as "already known" and move on — unless the user explicitly says to skip it.

- A `known_bug: true` entry in a scenario does NOT mean the bug is accepted. It means the team knows about it. It still requires a Debug task.
- An entry in `debug_log.md` does NOT mean the issue is resolved. If a scenario is still failing, it gets debugged again.
- "This was broken before my changes" is not a valid reason to skip. If it failed during this run, it gets a Fix task.
- The only valid reason to skip working an issue is an explicit user instruction given at invocation time.
- `flagged` is the **only** alternate terminal state, and it is itself "worked": it requires a real RCA attempt and the full evidence package described in the [Autonomous Run Policy](#autonomous-run-policy). Flagging without evidence is dismissal by another name.

This applies to all roles — manager, tester, debugger, and fixer. No team member may declare an issue out of scope without user authorization given before the run started.

---

## Skip Challenge Protocol — Manager Enforcement

**No scenario may be marked `skip` in the final report without passing Skip Challenge.** When a tester reports a skip (identified by `skip_challenge_required: true` in the result JSON):

### Manager Steps:
1. **Create a SkipChallenge task**:
   ```
   TaskCreate(
     subject="SkipChallenge: <category>/<scenario>",
     description="Tester proposed skip with reason: <skip_reason>.
       Investigate the live UI at http://localhost:${VITE_PORT}.
       Determine if the scenario can be automated with alternative steps.
       Output: updated scenario file if automatable, or confirmed-skip justification.
       Skip is ONLY valid for: clipboard API, live Claude response, wrong platform."
   )
   ```
2. **Spawn testing_analysis_expert** to investigate
3. **Wait for result**: Expert either confirms skip (with evidence) or provides new scenario steps
4. **If new steps provided**: Update the scenario file, create a new Run task for a tester
5. **If skip confirmed**: Record in report as `skip` with the expert's investigation evidence

### Skip counts in the final report as a coverage gap, not a clean result.

When generating the final report summary, always list skipped scenarios separately with their challenge status:
- `skip (confirmed)` — analysis_expert opened the browser and confirmed technically impossible
- `skip (unchallenged)` — no expert review performed — **this is a red flag, investigate before closing**

### Zero-skip goal:
The target for every run is zero unchallenged skips. If any scenario is skipped without expert review, the run is considered incomplete regardless of pass rate.
