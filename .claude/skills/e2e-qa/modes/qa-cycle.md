# QA Cycle Mode

When invoked with `run qa cycle` / `full qa` / `qa cycle`:

Runs all test suites in sequence across 12 phases. **You never advance to the next phase unless the current phase is RESOLVED** (see Phase Rules for the per-phase definition). All failures in a phase must be debugged and fixed — or, in phases 1–10, `flagged` — before moving on; in phases 11–12 an unresolved failure is a BLOCKED phase, not a flag.

> ## PASS MEANS PASS (non-negotiable)
>
> **A phase is `PASS` if and only if every test in it actually passed — zero failures, zero flagged.**
> There is no such thing as "PASS with N flagged". A phase that still has a red test is reported as
> **`RED — N failing (N flagged)`**, never as a pass, in the summary, in the report, in cycle-state,
> and in every sentence spoken to the user.
>
> `flagged` decides only ONE thing: whether the cycle may *advance* past the phase. It never upgrades
> a red test to green. The word for "we may move on" is **RESOLVED**, not "pass":
>
> | verdict | meaning |
> |---|---|
> | `PASS` | every test passed. Nothing red. The only verdict that may use this word. |
> | `RED — N failing (N flagged)` | worked to an evidenced, owned `flagged` state; cycle may advance; **the tests are still broken** |
> | `BLOCKED — N red: <files>` | phases 11–12 only; cycle may NOT advance |
>
> Reporting a red phase as PASS is a process violation on the same level as raising a timeout: it
> converts a real, unfixed defect into a green number someone will trust.

**Step 0.0 — INSTANCE-LEVEL OWNERSHIP (non-negotiable). You own what you launch — and ONLY what you launch.** The scope of your authority is the test instances the cycle starts via `scripts/instance_ctl.sh launch <name>` (and any backend/frontend/DB the cycle itself spawned). Within that scope you have full freedom, no confirmation needed:
- **Restart, clear/wipe/re-index the DB, kill, and relaunch instances YOU launched** — freely, as the phases require.
- **Manage their lifecycle: you MUST kill every instance you launched when you are done with it** (end of the phase that needed it, or end of the cycle). Don't leave instances running — accumulated stale instances are what caused past load problems.

**This is instance-level ownership, NOT machine-level. You do NOT own the machine.** Anything you did not launch is off-limits to destructive action — never kill, restart, clear, or wipe it without explicit per-action user approval:
- The user's **main dev backend / frontend** (`$LOCAL_SERVER_PORT` / `$VITE_PORT`) and its database — NEVER clear or wipe it. Phases that need a clean DB (10/11) run against a **dedicated instance you launched**, not the user's backend.
- The user's **running `claude`/agentic-process sessions, terminals, and any process you didn't spawn** — NEVER kill them, not even to reduce load or "as an RCA experiment." They are live work.
- **GUI apps** (browser, IDE) and OS daemons — never touch.

Mid-cycle you still don't pause for questions about work *inside your own instances* (decide-or-flag). But a destructive action on anything **outside** the instances you launched is NOT covered by any standing license — it requires explicit approval every time, in every context. A permission granted for one task never extends to a different task, a different resource, or a more destructive action. Reversing a safety decision you already made is a hard STOP, not a judgment call.

**Step 0 — verify and re-arm the watchdog loop.** Before every phase work session (including immediately after a session interruption, idle gap, /login recovery, or context reset), verify the cycle watchdog is still armed. Start it via the Skill tool if it is not running:

```
Skill(skill="loop", args='30m "Do not stop until every phase is RESOLVED (phases 1-10: every test passed, or each residual failure flagged; phases 11-12: every .md.ts exits 0, else the phase is BLOCKED). PASS MEANS PASS: only a phase with zero failures may be called PASS - a phase carrying flagged tests is reported RED - N failing (N flagged). flagged means a test exposes a significant gap needing senior-dev review; BLOCKED means a Playwright phase has a real, unmasked red .md.ts and the cycle cannot advance past it."')
```

The loop keeps the cycle driving forward unattended; it naturally ends when the QA Cycle Summary is printed (every phase RESOLVED — or a Playwright phase reported BLOCKED, which is itself the loud terminal outcome). The loop never overrides the circuit breaker (see SKILL.md, Run Integrity): on repeated same-class anomalies, a loop tick performs the meta-RCA instead of more forward grinding. **An unwatched cycle silently stops being a cycle,** so verify and re-arm at every session resume — the watchdog's presence tells you unattended progress is still happening.

**Step 0.4 — run timing-sensitive work on your own instance; clean up the instances you launch.** Timing-sensitive phases (3, 7, 10) need an uncontended backend. The way to get one is to **launch a dedicated instance for the cycle** (`scripts/instance_ctl.sh launch <name>`) and run against it — NOT to "reclaim the machine" by killing things you didn't start.

- **Only ever kill/clear instances YOU launched.** You may freely `kill` + `launch` *your own* instance to recover it, and clear *its* DB. Track which instances the cycle started.
- **At the end of every phase that launched an instance, and at the end of the cycle, kill the instances you launched** (`scripts/instance_ctl.sh kill <name>`). Leaving them running is what accumulates the stale-instance load that hurts the next run. Lifecycle is your responsibility.
- **If the host is loaded by things you did NOT launch** — the user's main backend, their live `claude`/agentic sessions, GUI apps, OS daemons — that load is **not yours to kill.** Do not touch it. Record it as a host-load caveat on the affected timing verdicts (or `flag` the phase as host-bound), and proceed. A slow timing verdict caused by the user's own workload is reported honestly, never "fixed" by killing their processes.
- **For browser-phase instances (Phases 11–12), verify authentication before running data-dependent scenarios.** A dedicated instance used for Phases 11/12 must be authenticated (hub up → cloud login succeeded) before its data-dependent browser failures can be trusted as regressions. Launch the instance, then verify against ITS port (`QA_BE=$(uv run flow instance ctl port <INSTANCE> --role backend)`, never `${LOCAL_SERVER_PORT}`): `B=$(curl -s http://localhost:${QA_BE}/api/v1/graph/bootstrap); echo "$B" | grep -q '"projects"' && ! echo "$B" | grep -q '"projects":\[\]'`. If bootstrap returns empty projects (unauthenticated instance), the hub is either down or cloud login failed — coordinate with Phase 9's hub bring-up. Data-independent test categories may run on unauthenticated instances; data/session/auth-dependent failures are environmental artifacts, not real bugs, and Phase 12 must not chase them. Flag the phase instead (reason: instance unauthenticated, hub dependency unmet).

```bash
# correct pattern: a dedicated instance you own, cleaned up after
scripts/instance_ctl.sh launch qa-cycle        # you launched it → you own it
# ... run the phase against qa-cycle's backend/frontend ...
scripts/instance_ctl.sh kill qa-cycle          # MUST clean up what you launched
```

Never raise a timeout to mask host-load slowness, and never kill a process you didn't launch to remove it. Those are the two banned shortcuts.

**Instance reset primitive (`flow instance reset <name>`) — the Phase 11/12 workhorse.** Between browser test units, do NOT rely on `desktop-db/clear` — it only wipes the DB, never the *process*, so a dedicated backend degrades after ~4-5 heavy real-Claude-PTY categories (leaked PTY/subprocess children, connection/memory growth) and manufactures phantom failures. `flow instance reset <name>` fixes this at the root: it **kills the instance's processes** (flushing all leaked children), **wipes its DB** (fresh state), **relaunches**, **re-applies `view_mode=standard`**, and **waits for readiness** — in ~3-4s. It is **surgical**: only ever touches the named instance's own processes/dir/`.env.<name>.local`/keychain slot, and is **safe to run while sibling instances (`dev-1`/`dev-2`/`prod`) are up** — they are never disturbed. Flags: `--backend-only` (~3s; keeps vite + the cloud login up — the default for the sweep), `--no-relaunch` (kill+wipe only), `--keep-keychain`, `--json`. Verify it any time with `scripts/verify_instance_reset.sh`. Use it only on instances the cycle owns.

**Step 0.5 — create the cycle-state file and record every test verdict.** Create `<output-dir>/<timestamp>/cycle-state.md` (phase, per-item dispositions, owners, instance locks, pending validations) and update it at every milestone — see SKILL.md "Durable cycle state". **Critically: before anything else starts (before the next phase work begins), every test attempt must end by recording its verdict** — either the test passed/failed outcome, or an explicit "no verdict: <reason>" — in cycle-state.md. An attempt without a recorded verdict is indistinguishable from an attempt that never ran, leaving the cycle's history incomplete and resumption ambiguous.

---

## Phase Rules

- **PASS** has ONE meaning in every phase: **the runner exited 0 with zero failures.** Nothing else may
  be written or spoken as PASS. See "PASS MEANS PASS" at the top of this file.
- **RESOLVED** (may the cycle advance?) depends on the phase:
  - **Phases 1–10 (pytest/vitest)** = all tests exit with 0 failures (**→ PASS**), OR every residual
    failure has been worked to a `flagged` terminal state per SKILL.md, "Autonomous Run Policy"
    (**→ `RED — N failing (N flagged)`; the phase is NOT a pass**). Flagged is a tracked,
    evidence-backed state — never a silent skip, and never a green number.
  - **Phases 11–12 (Playwright `.md.ts`)** = every `.md.ts` exits 0 under the manager's full-sweep re-run (machine-read), the only non-green being a documented env `test.skip(...)`. **`flagged` is not available here** — any residual red is a **BLOCKED** phase (the loud terminal state), not a quarantined flag.
  - No skipped failures allowed unless the user pre-approved skipping a specific test in the invocation. **Before reporting a phase complete, record an individual disposition for every failure** (fixed with evidence; flagged-with-reason in 1–10; BLOCKED-with-red-file in 11–12; or test-issue diagnosed) — a cluster-level classification ("N failures are all <class>") is never a verdict. Grouping by signature orders the work; it never substitutes for examining each member, because deterministic bugs hide behind plausible cluster narratives.
- **On failure**: debug the failing test(s) one by one using the Debug Mode flow (see `modes/debug.md`). Do NOT re-run the full suite after every individual fix — fix all failures first, then re-run the phase once as a final verification.
- **Never skip** a failing test without explicit user instruction given at invocation time. "It was already failing" is not a reason to move on. Mid-cycle, the only alternative to fixing is `flagged` (phases 1–10) or a BLOCKED phase (phases 11–12) — never a silent move-on.
- **Backend/infra ownership**: every backend phase (2, 3, 5, 7–12) runs against an instance THIS CYCLE LAUNCHED — never the user's dev backend at `${LOCAL_SERVER_PORT}`. Within your own instances you may restart, clear and relaunch freely (`scripts/instance_ctl.sh`, `flow instance reset`). You may NOT restart, instrument, clear or otherwise mutate the user's backend, not even to reproduce a failure: **if a symptom appears only on the user's instance, clone the conditions onto an instance you own — do not mutate theirs.** (2026-08-20: this bullet previously read "you own the machine … restart the backend as needed", which contradicts Step 0.0; it was read as a licence, the user's backend was killed to reload instrumentation, and it stayed down until noticed.)
- **Before each backend phase starts**, verify YOUR instance's health by polling its `/api/v1/graph/bootstrap` until it returns a valid payload containing `types`. (Do NOT gate on non-empty `projects`: a freshly launched instance legitimately reports `projects: []` until it is cloud-logged-in, and the user's own backend reports its projects only for the logged-in user — neither is a corruption signal.) A backend that never becomes ready is an infra failure for that phase, not a verdict.
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

> **Target (non-negotiable): a cycle-owned instance, never `${LOCAL_SERVER_PORT}`.** Launch or reuse
> one you own, then pass BOTH its realm and its port — the suite resolves its backend from them:
> ```bash
> uv run flow instance ctl is-up qa-cycle || scripts/instance_ctl.sh launch qa-cycle
> QA_BE=$(uv run flow instance ctl port qa-cycle --role backend)
> [ -n "$QA_BE" ] || { echo "FATAL: no live backend port for qa-cycle"; exit 1; }
> ```

```bash
FLOW_INSTANCE=qa-cycle LOCAL_SERVER_PORT=${QA_BE} python -m pytest tests/api/ -v
```

- **Gate**: all tests pass → proceed to Phase 3

## Phase 3 — pytest long tests (backend required)

```bash
# Phase 3 is TIMING-SENSITIVE — run it against a DEDICATED instance you launch,
# NEVER the main dev backend. The main backend's loaded DB makes createProcess
# pathologically slow (~32s on a 61-project DB vs ~0.8s on a fresh instance),
# which times out the real-CLI matrix tests for reasons that are pure
# environment, not code. (The long tests now REQUIRE an explicit FLOWPAD_HUB_URL
# and skip if unset — they will no longer silently target localhost:9008.)
uv run flow instance ctl is-up qa-cycle || scripts/instance_ctl.sh launch qa-cycle
QA_BE=$(uv run flow instance ctl port qa-cycle --role backend)
[ -n "$QA_BE" ] || { echo "FATAL: no live backend port for qa-cycle"; exit 1; }
DEEP_TESTING=1 FLOWPAD_HUB_URL="http://localhost:${QA_BE}" python -m pytest tests/long_tests/ -v
```

> **Never parse `status` text for a port or for "is it up".** The old recipe here
> did (`grep -oE 'backend :[0-9]+' | grep -A0 qa-cycle`) and was silently broken:
> the first `grep -o` strips the instance name from every line *before* the
> second grep looks for it, so `QA_BE` was always empty and `FLOWPAD_HUB_URL`
> became `http://localhost:`. The long tests then skipped and the phase read as
> a pass. `port` prints nothing and exits non-zero when there is no live
> backend, so the guard above can actually fire.

- Always set `DEEP_TESTING=1` (not `=true` — pydantic BaseSettings parses booleans inconsistently).
- `FLOWPAD_HUB_URL` MUST point at the dedicated instance you launched, not `${LOCAL_SERVER_PORT}` (the main backend). The matrix/streaming long tests skip cleanly when it is unset.
- **Cleanup**: `scripts/instance_ctl.sh kill qa-cycle` when Phase 3 (and any later timing phase reusing it) is done.
- **Gate**: all tests pass → proceed to Phase 4

## Phase 4 — vitest unit tests

```bash
cd ui && npm run test:vitest:unit
```

- **Gate**: all tests pass → proceed to Phase 5

## Phase 5 — vitest API tests (backend required)

> **Target (non-negotiable): a cycle-owned instance, never `${LOCAL_SERVER_PORT}`.** Launch or reuse
> one you own, then pass BOTH its realm and its port — the suite resolves its backend from them:
> ```bash
> uv run flow instance ctl is-up qa-cycle || scripts/instance_ctl.sh launch qa-cycle
> QA_BE=$(uv run flow instance ctl port qa-cycle --role backend)
> [ -n "$QA_BE" ] || { echo "FATAL: no live backend port for qa-cycle"; exit 1; }
> ```

```bash
cd ui && FLOW_INSTANCE=qa-cycle LOCAL_SERVER_PORT=${QA_BE} npm run test:vitest:api
```

- **`FLOW_INSTANCE` is REQUIRED, not decoration.** `tests/api/setup_project_stale_memory.test.ts`
  refuses to run without it ("it creates real projects, and `.env.local` is never a live-test
  fallback") — that refusal is the tier telling you the target is wrong.
- **The npm script carries `--bail 1`.** A bailed run reports the remaining files as *skipped*,
  which reads like coverage but is an artifact — take the phase verdict from a NO-BAIL run
  (`npx vitest run --project api`). If that exceeds the foreground budget, split it with
  `--shard=1/4 … 4/4` (batching, NOT a timeout change) rather than backgrounding it.
- **Gate**: all tests pass → proceed to Phase 6

## Phase 6 — vitest react tests

```bash
cd ui && npm run test:vitest:react
```

- **Gate**: all tests pass → proceed to Phase 7

## Phase 7 — vitest long tests (backend required)

> **Target (non-negotiable): a cycle-owned instance, never `${LOCAL_SERVER_PORT}`.** Launch or reuse
> one you own, then pass BOTH its realm and its port — the suite resolves its backend from them:
> ```bash
> uv run flow instance ctl is-up qa-cycle || scripts/instance_ctl.sh launch qa-cycle
> QA_BE=$(uv run flow instance ctl port qa-cycle --role backend)
> [ -n "$QA_BE" ] || { echo "FATAL: no live backend port for qa-cycle"; exit 1; }
> ```

```bash
cd ui && FLOW_INSTANCE=qa-cycle LOCAL_SERVER_PORT=${QA_BE} npm run test:vitest:long
```

- **Gate**: all tests pass → proceed to Phase 8

## Phase 8 — vitest headless tests (backend required)

> **Target (non-negotiable): a cycle-owned instance, never `${LOCAL_SERVER_PORT}`.** Launch or reuse
> one you own, then pass BOTH its realm and its port — the suite resolves its backend from them:
> ```bash
> uv run flow instance ctl is-up qa-cycle || scripts/instance_ctl.sh launch qa-cycle
> QA_BE=$(uv run flow instance ctl port qa-cycle --role backend)
> [ -n "$QA_BE" ] || { echo "FATAL: no live backend port for qa-cycle"; exit 1; }
> ```

```bash
cd ui && FLOW_INSTANCE=qa-cycle LOCAL_SERVER_PORT=${QA_BE} npm run test:vitest:headless
```

- Headless = the full app booted in jsdom + RTL against the LIVE backend, no mocks
  (the in-process E2E tier; see `ui/tests/headless/CLAUDE.md`). Single backend only — no
  hub/instances needed.
- The suite self-skips if the backend is unreachable; a skip here is NOT a pass — bring YOUR
  instance up and re-run (zero infra-skips in a PASS).
- To ADD coverage (e.g. a regression that needs the full app + a real backend but no
  browser), author a `*.test.tsx` here using the `setupLiveBackend`/`bootApp` harness —
  the recipe + tier rules are in `ui/tests/headless/CLAUDE.md` ("Authoring a new headless test").
- **Gate**: all tests pass → proceed to Phase 9

## Phase 9 — pytest hub tests (hub + instances required)

1. **Hub preflight**: `set -a; source .env.local; set +a` then check `curl -sf ${FLOWPAD_HUB_URL:-http://localhost:8093}/api/v1/health/status`.
   - If down, bring the whole stack up (Neo4j → hub → seed users) by following the canonical runbook **`../test_flowpad/FlowPad/docs/hub_setup.md`** — the hub doc owns the exact commands and creds. The stack is fully CLI-startable (no GUI): start the Neo4j "local" DBMS headless via its bundled `bin/neo4j` (needs `JAVA_HOME` → openjdk@21), then start the hub with `uv run python flowpad/run.py` (its 3.12 venv), then `ops/scripts/setup_test_users.sh`. Re-check health after.
   - Only `flag` Phases 9 **and** 10 if the stack is genuinely unrecoverable after working that runbook (e.g. the hub checkout, its venv, Neo4j install, or openjdk@21 are missing) — capture the failing step's log as evidence, then continue to Phase 11.
2. **Instances**: check `scripts/instance_ctl.sh status` first — **reuse any instance that is already UP** (do not relaunch it; `launch` kills an existing instance before starting, so re-launching a healthy one is a needless restart). Launch only what's missing via `scripts/instance_ctl.sh launch <name>`; if an instance goes unhealthy mid-phase, restart it with `kill <name>` + `launch <name>`.
3. **Run**:
   ```bash
   FLOWPAD_HUB_URL=${FLOWPAD_HUB_URL:-http://localhost:8093} python -m pytest tests/hub_tests -v
   ```
4. **Auto-skips count as failures.** `tests/hub_tests/conftest.py` silently skips when the hub is unreachable or credentials are invalid. A skipped-for-infra test is NOT a pass — remediate (restart hub, re-seed users via `setup_test_users.sh`) and re-run. Zero hub-infra skips allowed in a PASS.
5. **On failure**: existing Debug Mode flow (see `modes/debug.md`); unresolvable → `flagged`.
6. **Cleanup (always, even when flagging)**: `scripts/instance_ctl.sh kill <name>` for every instance THIS phase launched. Do not kill instances you didn't launch; leave the hub running for Phase 10.
- **Gate**: RESOLVED (all tests pass, or each residual failure flagged) → proceed to Phase 10. Report `PASS` only with zero failures; otherwise `RED — N failing (N flagged)`.

## Phase 10 — vitest hub tests (hub + dev-1/dev-2 required)

1. **Hub preflight**: same as Phase 9 (reuse its result if the hub is already up and healthy).

   > **The hub tests run ENTIRELY on cycle-owned instances — never on the user's main dev backend (`localhost:9008` / `FLOW_INSTANCE=oss`), and NEVER by editing the repo's `.env.local`.** Every hub test (both the `getInstance('dev-1'/'dev-2')` two-client files AND the single-backend `setupLiveBackend`/`SHARE_INST_*` files like `asset_share_index_matrix`) resolves its backend per-realm from `.env.<name>.local` and overrides `__FLOWPAD_API_URL__` at import — so the hub `vitest.config`'s `LOCAL_SERVER_PORT` (9008) fallback is a **red herring that is immediately overridden** and is not actually used. If a hub test is failing, do NOT diagnose it as "9008/alice is logged out" and do NOT restart or reconfigure the user's backend or uncomment `FLOWPAD_HUB_URL` in the repo `.env.local` to "fix" it — that is the wrong layer and touches the user's environment. Create whatever you need as your OWN `dev-1`/`dev-2` instances instead.

2. **Instances**: the suite expects the fixed names **dev-1** and **dev-2** (`ui/tests/hub/_instances.ts`). Check first, reuse if already UP — launch only what's missing (`launch` restarts an existing instance, so don't run it against a healthy one):
   ```bash
   scripts/instance_ctl.sh status            # see what's already UP
   scripts/instance_ctl.sh launch dev-1      # only if dev-1 is not UP
   scripts/instance_ctl.sh launch dev-2      # only if dev-2 is not UP
   scripts/instance_ctl.sh status            # wait until both report UP
   ```
   **UP is not enough — verify both are cloud-LOGGED-IN to the local hub before trusting any verdict.** A launched-but-logged-out instance makes the share/poll tests hang to timeout (they wait forever for a hub WS delivery that never comes). `instance_ctl` auto-logs-in on `launch`, but an instance that was already UP may have dropped its session. Check each:
   ```bash
   for p in dev-1 dev-2; do
     port=$(grep LOCAL_SERVER_PORT "$(git rev-parse --show-toplevel)/.env.$p.local" | cut -d= -f2)
     curl -s "http://localhost:$port/api/v1/cloud/status" \
       | python3 -c "import sys,json;d=json.load(sys.stdin).get('data',{});print('$p',d.get('login',{}).get('status'),'hub_ws=',d.get('hub_ws_connected'),d.get('cloud_url'))"
   done
   # Require: status=logged_in, hub_ws=True, cloud_url=http://localhost:8093/api/v1 for BOTH.
   ```
   If either is `logged_out` or points at a non-local `cloud_url`, `kill` + `launch` it (which re-triggers hub signup + cloud login) — do NOT reach for the user's backend.
3. **Run — always the FULL project, never per-file for the verdict.** Several hub files are **paired sender/receiver tests** (`matrix.alice`/`matrix.bob`, `conversation_messages.test`/`conversation_messages.bob.test`): the two halves run CONCURRENTLY in the same project run and rendezvous over the hub. Running one paired file in isolation **hangs or fails-fast waiting for a counterpart that never runs** — that is a harness artifact, not a real failure. Use the whole-project run for the machine verdict:
   ```bash
   cd ui && FLOWPAD_HUB_URL=http://localhost:8093 npm run test:vitest:hub
   ```
   Per-file runs are only for RCA of a NON-paired file already known to fail in the full run.
4. **On failure**: Debug Mode flow (see `modes/debug.md`). First rule out the two artifacts above (logged-out instance; a paired file isolated). Restart instances between re-runs as needed (`kill` + `launch`). The suite's 30s test timeouts are a hard cap — never raise them. A genuine hang/failure with both instances logged-in and the full project running is a REAL bug to RCA. Unresolvable → `flagged`.
5. **Cleanup (always, even when flagging)**: kill only the instances THIS phase launched:
   ```bash
   scripts/instance_ctl.sh kill dev-1   # only if Phase 10 launched it
   scripts/instance_ctl.sh kill dev-2   # only if Phase 10 launched it
   ```
   Instances that were already running before the phase started belong to the user's setup — leave them up, and leave the hub running.
- **Gate**: RESOLVED (all tests pass, or each residual failure flagged) → proceed to Phase 11. Report `PASS` only with zero failures; otherwise `RED — N failing (N flagged)`.

## Phase 11 — Playwright `.md.ts` green gate (HARD GATE)

A closed-loop gate over every `.md.ts` Playwright test. **The cycle cannot pass this phase until every `.md.ts` exits 0 under the manager's own re-run.** The machine verdict — the Playwright exit code / JSON report — is the sole source of truth; **no agent's self-report ever greens a file.** This is the phase that catches real regressions, so it must block, not merely record: a prior regression "had a test but still escaped" precisely because this phase used to be advisory.

**Before launching the sweep, verify system load is low.** Check `uptime` and examine the 1-minute load average. If it exceeds approximately the machine's core count, defer the sweep (run lower-load work or wait) and re-check — timeout-bound Playwright verdicts collected on a saturated host are noise that will require re-running anyway, and raising timeouts is not permitted. A clean run under normal load is far more valuable than a timeout-saturated run under pressure.

**Preflight: force the instance to `view_mode=standard` (NON-OBVIOUS, blocks the whole sweep otherwise).** `instance_ctl` creates a brand-NEW hub account, and a new account is seeded `preferences.ui.view_mode=vibe`. Vibe renders the "Build something amazing" creator homepage — which has NONE of the standard `HomeLanding` surfaces the manual-regression suite asserts (`/dock/home` "Hey <name>" greeting, `[data-testid="recent-conversations-strip"]`, current-activity). On a Vibe-defaulted instance the `general` category fails ~8/13 and many category tests fail systematically — looking like a mass regression when it is purely the view-mode default. The suite targets the STANDARD surface, so set it once before the sweep (preferences.json is separate from the graph DB, so it survives the per-category DB clears):
```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / ".flow/instances/<INSTANCE>/preferences.json"
d = json.loads(p.read_text()); d["preferences.ui.view_mode"] = "standard"
p.write_text(json.dumps(d, indent=2)); print("view_mode -> standard")
PY
```
The frontend reads `preferences.json` fresh via its VFS path at each app boot, so no backend restart is needed. Verified: `general` goes 8-fail → 13/13 pass with this one change. **`flow instance reset` (used per-file in 11a below) re-applies `view_mode=standard` automatically on every relaunch**, so once the sweep uses reset you don't need to re-set it manually — but still confirm it once, and if a NEW category fails wholesale on homepage/greeting locators, re-check this pref first.

**Write integrity while the sweep runs:** The sweep clears the DB and mutates instances repeatedly across 18 categories in the background. While the sweep is running, those instances are exclusively owned by the sweep — **record no other verdicts against them, run no other suites, clear no DBs, restart nothing on them.** A verdict collected while another actor mutates the environment is not a verdict (reference SKILL.md "One writer per instance"); concurrent writes manufacture false failures. Schedule verification work that needs the same instances before the sweep starts or after it completes. The background sweep provides load isolation automatically — do serial verification work on a separate instance or interval, never during.

### 11a. Sweep — machine verdict (authoritative)

1. Build/refresh the test index. List every `.md.ts` file under `scenarios-dir` (per file, not just per category).
2. **Hybrid cadence — `flow instance reset` per CATEGORY + `desktop-db/clear` per FILE.** This is evidence-based (learned the hard way this cycle):
   - The backend degradation is **cumulative across categories** (leaked PTY/claude children accumulate; `desktop-db/clear` never resets the *process*, so after ~4-5 heavy categories it starts timing out and mass-fails). A **full `flow instance reset` at the START of each category** flushes that accumulation — a fresh, non-degraded backend per category.
   - But a **cold-booted backend can't surface warm-state-dependent tests** (e.g. an asset picker's self-seeded agent won't appear in the tree on a just-restarted backend — proven: `assets/agent_execution_asset_picker` 8/8 after `desktop-db/clear` vs 9/9 FAIL right after a reset). So **within a category, use `desktop-db/clear` per file** (fresh DB, backend stays warm) — NOT another reset.
   ```bash
   # --- resolve YOUR instance's port ONCE. `desktop-db/clear` WIPES the database it
   # --- reaches: ${LOCAL_SERVER_PORT} is the USER'S dev backend, so it must never
   # --- appear in these commands. Resolve the owned instance and fail closed.
   QA_BE=$(uv run flow instance ctl port <INSTANCE> --role backend)
   [ -n "$QA_BE" ] || { echo "FATAL: no live backend port for <INSTANCE> — refusing to clear"; exit 1; }
   [ "$QA_BE" != "${LOCAL_SERVER_PORT}" ] || { echo "FATAL: resolved the user's backend — refusing to clear"; exit 1; }

   # --- once at the START of each category (fresh, warm backend) ---
   if ! uv run flow instance reset <INSTANCE> --keep-keychain --json | tee /dev/stderr | grep -q '"ready": true'; then
     echo "category reset not ready — aborting category"; exit 1
   fi
   # --- then, before EACH .md.ts file in the category ---
   CLR=$(curl -s -X POST http://localhost:${QA_BE}/api/v1/graph/compute_node/@local/desktop-db/clear)
   echo "$CLR" | grep -q '"backup_path"' || { echo "db clear failed: $CLR"; exit 1; }
   for i in {1..30}; do curl -s http://localhost:${QA_BE}/api/v1/graph/bootstrap 2>/dev/null | grep -q '"types"' && break; sleep 1; done

   cd ui && VITE_PORT=${VITE_PORT} \
     PLAYWRIGHT_JSON_OUTPUT_NAME=<abs-results-dir>/<timestamp>/phase11--<category>--<file>.json \
     npx playwright test --config tests/manual_regression/<category>/playwright.config.ts <file>.md.ts --reporter=json
   ```
   `flow instance reset` re-applies `view_mode=standard` on relaunch, is surgical (never touches sibling instances), and takes ~3-4s. Gate readiness on `"types"` present (an unauthed dedicated instance shows `projects:[]`, which is normal). If a *single* heavy category (e.g. `terminal`, 31 files) still degrades mid-category, add a per-file reset for that one category only — but a per-file reset universally breaks the warm-state tests, so it is NOT the default. (`<INSTANCE>` = the dedicated instance you launched.)
3. Parse each `phase11--<category>--<file>.json` and aggregate into `<output-dir>/<timestamp>/phase11-summary.json`:
   - one entry per test: `{ category, file, test_title, status, duration_ms, error_excerpt }`
4. Print the per-test pass/fail table:
   ```
   Phase 11 — Playwright sweep
   ───────────────────────────
   <category>/<file> :: <test title>   PASS|FAIL  (Xs)
   ...
   Total: N tests — N passed, N failed
   ```

### 11b. Per-failing-file RCA + fix — one agent per failing `.md.ts`

For each `.md.ts` file with ≥1 non-passing test (`failed`/`timedOut`/`interrupted`; a real in-code `test.skip(...)` is allowed — see the gate), spawn **one agent that owns that single file to green**:

- The agent runs the file, and on failure **RCAs the full flow against the sibling `.md`** (the source of truth) using the `rca` skill's on/off-switch method: prove the cause with a toggle, then classify honestly — `fail` → fix the **app**; `test-issue` → fix the **`.md.ts`** (selectors/timing/steps; never weaken or delete an assertion to go green). If the failing `.md.ts` has **no** sibling `.md`, RCA from the test + app directly.
- The agent re-runs until the file exits 0, then stability-checks with `--repeat-each=3` (a stability check on the just-changed file — `retries` stays 0; this is never a retry mask).
- **Concurrency follows "one writer per instance":** failing-file agents run in parallel ONLY when each owns a separate instance (the manager grants ownership explicitly); on a single shared instance they run serially, each doing a `flow instance reset <INSTANCE> --backend-only` first (surgical — safe even while sibling agents own other instances).
- Bounded effort per file = the standard Run Mode attempts (2 fix→re-validate retries; fixer↔debugger 3 iterations). A file still red after that is **not flagged** — it remains a hard block (see gate).

### 11c. Gate — manager re-runs the FULL sweep

Re-run **11a** end to end. **Phase 11 passes only when the manager's own re-run of every category exits 0** (modulo documented env-skips below). An agent that crashed, hung, or misreported leaves its file red → the re-run is non-zero → the phase is **BLOCKED**. Green is established by the deterministic sweep, never by an agent's word — this is the exact hole through which a tested regression once escaped.

- **No `flagged` in this phase.** The only non-green allowed is a real, in-code Playwright `test.skip(...)` for one of the three documented environment reasons (clipboard API / live-Claude actively responding / wrong-platform — see `agents/qa-tester.md`), and it must be visible in the JSON report, not a verbal disposition. Every other non-green blocks the gate until fixed.
- **Gate**: full-sweep re-run all-green → proceed to Phase 12. Otherwise Phase 11 is **BLOCKED** and the cycle's headline result is that block — it does **not** advance with red `.md.ts` files quarantined. (BLOCKED is the intended, loud outcome: surfacing a real failure beats silently passing it.)

## Phase 12 — `.md`-only → author `.md.ts` (coverage gate)

Phase 11 now owns every failing `.md.ts`. Phase 12's sole remaining job is **specs with no executable test**: turn each `.md` that has no sibling `.md.ts` into a passing `.md.ts`, so Playwright coverage grows every cycle and a written spec can never sit un-executed. Team-based, full methodology — Run Mode steps 1–12 (see `modes/run.md`), Debug Mode lifecycle (see `modes/debug.md`), up to 3 qa-testers with the per-test tab protocol.

**PREREQUISITE: Instance authentication (see Step 0.4).** Before running any Phase 12 scenario against a dedicated instance, verify the instance is authenticated against ITS port (never `${LOCAL_SERVER_PORT}`): `B=$(curl -s http://localhost:${QA_BE}/api/v1/graph/bootstrap); echo "$B" | grep -q '"projects"' && ! echo "$B" | grep -q '"projects":\[\]'`. If bootstrap returns empty projects, the instance has no user-scoped data — hub is down or cloud login failed. Halt the phase and bring the hub/auth up before proceeding (reason: cannot run data-dependent browser scenarios without authenticated user data). Do not run scenarios against an unauthenticated instance; failures will be environmental artifacts, not regressions.

### Coverage detection — filesystem diff (the authoritative orphan source)

The work set is every `.md` with no `<name>.md.ts` sibling. Derive it directly from the filesystem, not from the hand-maintained index:
```bash
# Robust under bash and zsh (no glob-expansion errors on empty dirs).
for d in ${scenarios-dir}/*/; do
  comm -23 \
    <(find "$d" -maxdepth 1 -name '*.md' -not -name '*.md.ts' \
        | xargs grep -L '^manual: true' 2>/dev/null | sed 's|.*/||; s/\.md$//' | sort) \
    <(find "$d" -maxdepth 1 -name '*.md.ts'                      | sed 's|.*/||; s/\.md\.ts$//' | sort) \
  | sed "s|^|$(basename "$d")/|"
done
# A spec whose frontmatter declares `manual: true` states in its own text that it
# is not automatable in this harness (real E2B minutes, two browser profiles,
# secrets a test cannot mint). It is excluded here and reported as manual, never
# authored as a hollow test.skip stub.
```
That list IS Phase 12's complete scope. (A `.md.ts` with no `.md` is fine — Phase 11 already runs it. A failing `.md.ts` is **not** in scope here; it was resolved in Phase 11.)

### Per orphan `.md` — three sub-goals, in order, all required

1. **Make the full `.md` scenario pass.** The `.md` is the source of truth. Reset the DB first (preflight below). Classify honestly: `fail` → fix the app; `test-issue` → fix the scenario.
2. **Author a new `.md.ts`** in the same category directory, following its existing conventions (shared helpers, one `test('...')` per `test N:` block; the per-category `playwright.config.ts` picks it up via `testMatch: '*.md.ts'`). It must encode exactly what the `.md` validates — no extra assertions, none weakened. Playwright coverage grows every cycle.
3. **Make the `.md.ts` pass + prove stability.** Re-run it until green, then:
   ```bash
   cd ui && VITE_PORT=${VITE_PORT} npx playwright test --config tests/manual_regression/<category>/playwright.config.ts <scenario>.md.ts --repeat-each=3
   ```
   (`--repeat-each=3` is a stability check on the just-authored test — it is NOT a retry mask; `retries` stays 0.)

- **Once before the phase** (and any time the backend has degraded), `flow instance reset <INSTANCE> --keep-keychain` for a fresh, non-degraded, warm backend. **Then before each scenario**, `desktop-db/clear` for a fresh DB WITHOUT restarting the backend (a cold backend can't surface warm-state-dependent scenarios — see Phase 11 11a):
  ```bash
  # Same guard as 11a: this WIPES the database it reaches, and ${LOCAL_SERVER_PORT}
  # is the USER'S backend. Resolve the owned instance and fail closed.
  QA_BE=$(uv run flow instance ctl port <INSTANCE> --role backend)
  [ -n "$QA_BE" ] || { echo "FATAL: no live backend port for <INSTANCE> — refusing to clear"; exit 1; }
  [ "$QA_BE" != "${LOCAL_SERVER_PORT}" ] || { echo "FATAL: resolved the user's backend — refusing to clear"; exit 1; }

  CLR=$(curl -s -X POST http://localhost:${QA_BE}/api/v1/graph/compute_node/@local/desktop-db/clear)
  echo "$CLR" | grep -q '"backup_path"' || { echo "db clear failed: $CLR"; exit 1; }
  for i in {1..30}; do curl -s http://localhost:${QA_BE}/api/v1/graph/bootstrap 2>/dev/null | grep -q '"types"' && break; sleep 1; done
  ```
  Data-dependent scenarios must self-seed via API + `fs-records/index` after the clear (the DB starts empty; the reset re-seeds only system projects).
- A scenario's task is complete only when all three sub-goals hold (`.md` ✓ AND a newly-authored `.md.ts` ✓ stable).
- **Gate (hard, no `flagged`):** after authoring, the manager **re-runs the affected categories' full sweep** (11a mechanics); every newly-authored `.md.ts` must exit 0. The only non-green allowed is a documented env-SKIP expressed as a real `test.skip(...)`. A `.md` that cannot be made to pass — or whose authored `.md.ts` stays red after the bounded Run Mode attempts — is a hard **BLOCK** reported in the summary, never quarantined-and-passed. Then print the QA Cycle Summary.

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
Phase 8  (vitest headless):   PASS — N tests
Phase 9  (pytest hub):        PASS — N tests          (or RED — N failing (N flagged))
Phase 10 (vitest hub):        PASS — N tests          (or RED — N failing (N flagged))
Phase 11 (playwright md.ts):  PASS — N green / N env-skip   (or BLOCKED — N red: <files>)
Phase 12 (author md.ts):      PASS — N authored / N env-skip (or BLOCKED — N red: <files>)

Total fixes applied: N
New .md.ts authored: N
Docs corrected: N
Flagged (phases 1–10): N (see _results/<timestamp>/flagged.md — senior dev review required)
Blocked (phases 11–12): N (see red .md.ts list above — these are real, unmasked failures)
```

A cycle is **RESOLVED** for phases 1–10 when every test is passed or flagged — but **only a phase with ZERO failures is written `PASS`**; a phase still carrying red tests is written `RED — N failing (N flagged)`. "Complete" never means "green". **Phases 11–12 admit no `flagged`**: they pass only when every `.md.ts` exits 0 (modulo documented env-skips); any residual red is a **BLOCKED** phase — a loud, unmasked failure, listed individually with its red file(s). Flagged items (phases 1–10) are listed individually below the table with their one-line reason.

**Upon completion, open the HTML report in the default browser** (`open <report-path>` on macOS, `xdg-open <path>` on Linux) so the results are immediately visible — then print the summary and the report path.
