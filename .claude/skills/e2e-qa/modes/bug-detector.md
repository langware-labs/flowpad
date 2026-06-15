# Bug Detector Mode

When invoked with `bug scan` / `bug detector` / `find bugs`:

Architecture-driven broad scan. Not targeted at a specific feature. The expert reads what's been scanned before, scans architecture/code/docs for new interesting edge cases, defines them in a temp location, then the team executes and debugs. Only tests confirming real bugs are promoted.

**Persistent log**: `.flow/skills/agentic-qa/corner_case_scan_log.md`
**Temp dir**: `ui/tests/manual_regression/_discovery/<timestamp>/`

---

## Step 1 — Read the log (manager)

Before creating any tasks, read `.flow/skills/agentic-qa/corner_case_scan_log.md`.
Pass its contents to the expert via the task description so they know what's already been explored.

---

## Step 2 — BugScan: discover new cases

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

## Step 3 — Execute: run all discovery scenarios

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

For any failure: invoke the full Debug Mode flow (see `modes/debug.md` for debugger → fixer → validate).

---

## Step 4 — Promote: real bugs → permanent scenarios (manager)

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

## Step 5 — Report

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
