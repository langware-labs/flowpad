# QA Cycle Mode

When invoked with `run qa cycle` / `full qa` / `qa cycle`:

Runs all test suites in sequence across 11 phases. **You never advance to the next phase unless the current phase achieves a clear pass.** All failures in a phase must be debugged and fixed — or flagged — before moving on.

**Step 0 — verify and re-arm the watchdog loop.** Before every phase work session (including immediately after a session interruption, idle gap, /login recovery, or context reset), verify the cycle watchdog is still armed. Start it via the Skill tool if it is not running:

```
Skill(skill="loop", args='30m "Do not stop until all passed or flagged. flagged means this test exposes significant gap hence senior dev review is required to decide on next step"')
```

The loop keeps the cycle driving forward unattended; it naturally ends when the QA Cycle Summary is printed (every test passed or flagged). The loop never overrides the circuit breaker (see SKILL.md, Run Integrity): on repeated same-class anomalies, a loop tick performs the meta-RCA instead of more forward grinding. **An unwatched cycle silently stops being a cycle,** so verify and re-arm at every session resume — the watchdog's presence tells you unattended progress is still happening.

**Step 0.5 — create the cycle-state file and record every test verdict.** Create `<output-dir>/<timestamp>/cycle-state.md` (phase, per-item dispositions, owners, instance locks, pending validations) and update it at every milestone — see SKILL.md "Durable cycle state". **Critically: before anything else starts (before the next phase work begins), every test attempt must end by recording its verdict** — either the test passed/failed outcome, or an explicit "no verdict: <reason>" — in cycle-state.md. An attempt without a recorded verdict is indistinguishable from an attempt that never ran, leaving the cycle's history incomplete and resumption ambiguous.

---

## Phase Rules

- **Clear pass** = all tests in the phase exit with 0 failures, OR every residual failure has been worked to a `flagged` terminal state per SKILL.md, "Autonomous Run Policy". Flagged is a tracked, evidence-backed state — never a silent skip. No skipped failures allowed unless the user pre-approved skipping a specific test in the invocation. **Before reporting a phase complete, record an individual disposition for every failure** (fixed with evidence, flagged with reason, or test-issue diagnosed) — a cluster-level classification ("N failures are all <class>") is never a verdict. Grouping by signature orders the work; it never substitutes for examining each member, because deterministic bugs hide behind plausible cluster narratives.
- **On failure**: debug the failing test(s) one by one using the Debug Mode flow (see `modes/debug.md`). Do NOT re-run the full suite after every individual fix — fix all failures first, then re-run the phase once as a final verification.
- **Never skip** a failing test without explicit user instruction given at invocation time. "It was already failing" is not a reason to move on. Mid-cycle, the only alternative to fixing is flagging.
- **Backend/infra ownership**: For phases 2, 3, 5, and 7–11, you own the machine. You may restart the backend server (`uv run -m flow_sdk.server.run`), the frontend, named instances (`scripts/instance_ctl.sh`), and the local hub as needed between runs. **Before each backend-owning phase starts**, verify the backend's health by polling `/api/v1/graph/bootstrap` — confirm it returns a valid, non-empty payload with populated `projects` (same machine-readable check used in Phase 10/11 DB clears). If bootstrap returns empty, errors, or indicates the DB is implausibly small vs. recent backups, stop immediately, restore from the most recent backup, and re-verify bootstrap before proceeding — corruption undetected between phases poisons every verdict recorded against it.
- **No flaky tolerance**: `retries` stays 0 everywhere. A test that passes on re-run with no code change is not green — it is evidence of a real race and is flag-worthy. Never add retries, reruns, or `@flaky` markers, and never raise any timeout (see CLAUDE.md non-negotiables).
- **Integrity & resilience**: every verdict, destructive op, infra launch, and anomaly response is governed by SKILL.md, "Run Integrity & Resilience" — machine-read verdicts, one writer per instance, daemonized services, durable cycle state, circuit breaker.

---

## Phase 1 — pytest unit tests

```bash
python -m pytest tests/unit/ -v
```

- Run from repo root
- **Gate**: all tests pass → proceed to Phase 2

## Phase 2 — pytest API tests (backend required)

```bash
# Ensure backend is running at localhost:${LOCAL_SERVER_PORT}
uv run -m flow_sdk.server.run &   # restart if needed

python -m pytest tests/api/ -v
```

- You own the backend. Restart it if unhealthy before running.
- **Gate**: all tests pass → proceed to Phase 3

## Phase 3 — pytest long tests (backend required)

```bash
# Ensure backend is running at localhost:${LOCAL_SERVER_PORT}
DEEP_TESTING=1 FLOWPAD_HUB_URL="http://localhost:${LOCAL_SERVER_PORT}" python -m pytest tests/long_tests/ -v
```

- Always set `DEEP_TESTING=1` (not `=true` — pydantic BaseSettings parses booleans inconsistently).
- Some long tests hardcode `FLOWPAD_HUB_URL` default to 8093; pass it explicitly.
- **Gate**: all tests pass → proceed to Phase 4

## Phase 4 — vitest unit tests

```bash
cd ui && npm run test:vitest:unit
```

- **Gate**: all tests pass → proceed to Phase 5

## Phase 5 — vitest API tests (backend required)

```bash
# Ensure backend is running at localhost:${LOCAL_SERVER_PORT}
cd ui && npm run test:vitest:api
```

- Backend must be running (you own it — restart if needed).
- **Gate**: all tests pass → proceed to Phase 6

## Phase 6 — vitest react tests

```bash
cd ui && npm run test:vitest:react
```

- **Gate**: all tests pass → proceed to Phase 7

## Phase 7 — vitest long tests (backend required)

```bash
# Ensure backend is running at localhost:${LOCAL_SERVER_PORT}
cd ui && npm run test:vitest:long
```

- Backend must be running (you own it — restart if needed).
- **Gate**: all tests pass → proceed to Phase 8

## Phase 8 — pytest hub tests (hub + instances required)

1. **Hub preflight**: `set -a; source .env.local; set +a` then check `curl -sf ${FLOWPAD_HUB_URL:-http://localhost:8093}/api/v1/health/status`.
   - If down: start the hub autonomously from the FlowPad checkout at the sibling checkout `../test_flowpad/FlowPad/` (run via `flowpad/run.py`, detached, output to a log file), then seed test users via `ops/scripts/setup_test_users.sh` in that checkout, then re-check health.
   - Still down (e.g., its Neo4j Desktop DB isn't running) → mark Phases 8 **and** 9 `flagged` (reason: hub infra unavailable, evidence: startup log excerpt) and continue to Phase 10.
2. **Instances**: check `scripts/instance_ctl.sh status` first — **reuse any instance that is already UP** (do not relaunch it; `launch` kills an existing instance before starting, so re-launching a healthy one is a needless restart). Launch only what's missing via `scripts/instance_ctl.sh launch <name>`; if an instance goes unhealthy mid-phase, restart it with `kill <name>` + `launch <name>`.
3. **Run**:
   ```bash
   FLOWPAD_HUB_URL=${FLOWPAD_HUB_URL:-http://localhost:8093} python -m pytest tests/hub_tests -v
   ```
4. **Auto-skips count as failures.** `tests/hub_tests/conftest.py` silently skips when the hub is unreachable or credentials are invalid. A skipped-for-infra test is NOT a pass — remediate (restart hub, re-seed users via `setup_test_users.sh`) and re-run. Zero hub-infra skips allowed in a clear pass.
5. **On failure**: existing Debug Mode flow (see `modes/debug.md`); unresolvable → `flagged`.
6. **Cleanup (always, even when flagging)**: `scripts/instance_ctl.sh kill <name>` for every instance THIS phase launched. Do not kill instances you didn't launch; leave the hub running for Phase 9.
- **Gate**: all tests pass (or flagged) → proceed to Phase 9.

## Phase 9 — vitest hub tests (hub + dev-1/dev-2 required)

1. **Hub preflight**: same as Phase 8 (reuse its result if the hub is already up and healthy).
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
4. **On failure**: Debug Mode flow (see `modes/debug.md`). Restart instances between re-runs as needed (`kill` + `launch`). The suite's 30s test timeouts are a hard cap — never raise them. Unresolvable → `flagged`.
5. **Cleanup (always, even when flagging)**: kill only the instances THIS phase launched:
   ```bash
   scripts/instance_ctl.sh kill dev-1   # only if Phase 9 launched it
   scripts/instance_ctl.sh kill dev-2   # only if Phase 9 launched it
   ```
   Instances that were already running before the phase started belong to the user's setup — leave them up, and leave the hub running.
- **Gate**: all tests pass (or flagged) → proceed to Phase 10.

## Phase 10 — Playwright `.md.ts` sweep

A fast, deterministic pass/fail sweep of every `.md.ts` Playwright test. **No team, no debugging, no fixes** — the manager runs it directly and records results. That's it.

**Before launching the sweep, verify system load is low.** Check `uptime` and examine the 1-minute load average. If it exceeds approximately the machine's core count, defer the sweep (run lower-load work or wait) and re-check — timeout-bound Playwright verdicts collected on a saturated host are noise that will require re-running anyway, and raising timeouts is not permitted. A clean run under normal load is far more valuable than a timeout-saturated run under pressure.

**Write integrity while the sweep runs:** The sweep clears the DB and mutates instances repeatedly across 18 categories in the background. While the sweep is running, those instances are exclusively owned by the sweep — **record no other verdicts against them, run no other suites, clear no DBs, restart nothing on them.** A verdict collected while another actor mutates the environment is not a verdict (reference SKILL.md "One writer per instance"); concurrent writes manufacture false failures. Schedule verification work that needs the same instances before the sweep starts or after it completes. The background sweep provides load isolation automatically — do serial verification work on a separate instance or interval, never during.

1. Build/refresh the test index. List every category dir under `scenarios-dir` that contains `.md.ts` files.
2. For each such category, reset the DB then run the category with the JSON reporter (machine-readable per-test results — never scrape list output):
   ```bash
   # Clear the DB and verify success by reading the response body (not discarded to /dev/null)
   CLEAR_RESPONSE=$(curl -s -X POST http://localhost:${LOCAL_SERVER_PORT}/api/v1/graph/compute_node/@local/desktop-db/clear)
   if ! echo "${CLEAR_RESPONSE}" | grep -q '"backup_path"'; then
     echo "DB clear failed or backup not verified: ${CLEAR_RESPONSE}"
     exit 1
   fi
   
   # Poll bootstrap until health returns valid, verifying re-index completed and records exist
   BOOTSTRAP_READY=0
   for i in {1..30}; do
     if BOOTSTRAP=$(curl -s http://localhost:${LOCAL_SERVER_PORT}/api/v1/graph/bootstrap 2>/dev/null); then
       if echo "${BOOTSTRAP}" | grep -q '"projects"' && ! echo "${BOOTSTRAP}" | grep -q '"projects":\[\]'; then
         BOOTSTRAP_READY=1
         break
       fi
     fi
     sleep 1
   done
   if [ $BOOTSTRAP_READY -eq 0 ]; then
     echo "Bootstrap health check failed after DB clear; re-index may have stalled"
     exit 1
   fi

   cd ui && VITE_PORT=${VITE_PORT} \
     PLAYWRIGHT_JSON_OUTPUT_NAME=<abs-results-dir>/<timestamp>/phase10--<category>.json \
     npx playwright test --config tests/manual_regression/<category>/playwright.config.ts --reporter=json
   ```
3. Parse each `phase10--<category>.json` and aggregate into `<output-dir>/<timestamp>/phase10-summary.json`:
   - one entry per test: `{ category, file, test_title, status, duration_ms, error_excerpt }`
4. Print the per-test pass/fail table:
   ```
   Phase 10 — Playwright sweep
   ───────────────────────────
   <category>/<file> :: <test title>   PASS|FAIL  (Xs)
   ...
   Total: N tests — N passed, N failed
   ```
- **Do not debug or fix anything in this phase.** Failures are recorded and become Phase 11's work list.
- **Gate**: Phase 10 never blocks — it always proceeds to Phase 11 with its failure list. (If Phase 10 has zero failures AND the test index shows no `.md`-only scenarios, Phase 11 is a no-op.)

## Phase 11 — agentic remediation (full `.md` scenarios)

Team-based agentic phase using the full methodology — Run Mode steps 1–12 (see `modes/run.md`), Debug Mode lifecycle (see `modes/debug.md`), up to 3 qa-testers with the per-test tab protocol.

**Scope** (from `phase10-summary.json` + the test index):
- (a) every scenario with a **failing `.md.ts`** in Phase 10
- (b) every `.md` scenario that has **no `.md.ts`** at all

**Per scenario, three sub-goals — in order, all required:**
1. **Make the full `.md` scenario pass.** The `.md` is the source of truth. Classify honestly: `fail` → fix the app; `test-issue` → fix the scenario.
2. **Fold learnings into the `.md.ts`.** Update the stale `.md.ts` with corrected selectors/timing/steps — or, for `.md`-only scenarios, **author a new `.md.ts`** following the category's existing conventions (`testMatch: '*.md.ts'`, same per-category `playwright.config.ts`). Playwright coverage grows every cycle.
3. **Make the `.md.ts` pass.** Re-run it until green, then confirm stability:
   ```bash
   cd ui && VITE_PORT=${VITE_PORT} npx playwright test --config tests/manual_regression/<category>/playwright.config.ts <scenario>.md.ts --repeat-each=3
   ```
   (`--repeat-each=3` is a stability check on the just-changed test — it is NOT a retry mask; `retries` stays 0.)

- **Before each scenario**, the tester must reset the DB to a clean state and verify restoration:
  ```bash
  # Clear the DB and read the response body to confirm success and backup (not discarded to /dev/null)
  CLEAR_RESPONSE=$(curl -s -X POST http://localhost:${LOCAL_SERVER_PORT}/api/v1/graph/compute_node/@local/desktop-db/clear)
  if ! echo "${CLEAR_RESPONSE}" | grep -q '"backup_path"'; then
    echo "DB clear failed or backup not verified: ${CLEAR_RESPONSE}"
    exit 1
  fi
  
  # Poll bootstrap until health returns valid, confirming re-index completed and records are restored
  BOOTSTRAP_READY=0
  for i in {1..30}; do
    if BOOTSTRAP=$(curl -s http://localhost:${LOCAL_SERVER_PORT}/api/v1/graph/bootstrap 2>/dev/null); then
      if echo "${BOOTSTRAP}" | grep -q '"projects"' && ! echo "${BOOTSTRAP}" | grep -q '"projects":\[\]'; then
        BOOTSTRAP_READY=1
        break
      fi
    fi
    sleep 1
  done
  if [ $BOOTSTRAP_READY -eq 0 ]; then
    echo "Bootstrap health check failed after DB clear; re-index may have stalled — aborting scenario"
    exit 1
  fi
  ```
  This backs up and wipes the DB + FTS index, verifies the backup succeeded and the re-index completed, then confirms records were restored before the scenario starts. A clear that leaves zero records means the re-index failed — the fixture catches that now, before burning test assertions against an empty DB.
- A scenario's task is complete only when all three sub-goals hold (`.md` ✓ AND `.md.ts` ✓ stable).
- Max 2 fix→re-validate retries per scenario (existing Run Mode rule), then `flagged`.
- **Gate**: every in-scope scenario is `resolved` or `flagged` → print the QA Cycle Summary.

---

## QA Cycle Summary Format

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
Phase 8  (pytest hub):        PASS — N tests (N flagged)
Phase 9  (vitest hub):        PASS — N tests (N flagged)
Phase 10 (playwright md.ts):  N passed / N failed → Phase 11
Phase 11 (agentic md+md.ts):  PASS — N scenarios (N flagged)

Total fixes applied: N
New .md.ts authored: N
Docs corrected: N
Flagged: N (see _results/<timestamp>/flagged.md — senior dev review required)
```

A cycle is **complete** when every test is passed or flagged. Flagged items are listed individually below the table with their one-line reason.

**Upon completion, open the HTML report in the default browser** (`open <report-path>` on macOS, `xdg-open <path>` on Linux) so the results are immediately visible — then print the summary and the report path.
