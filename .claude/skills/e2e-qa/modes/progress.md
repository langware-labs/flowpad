---
id: 94faf5d8-c716-44f5-8480-64b00e3759c3
---
# Plan & Progress — what the person watching sees (non-negotiable)

The person who started the cycle watches the **activity bar** (footer one-liner → details
modal). Everything they see comes from ONE activity tree that this skill builds per run.
It must say, at every moment, exactly what this run will do, where it is, and what broke.

## The tree

```
qa-<YYYYMMDD-HHMMSS>          root   label "QA cycle" (or "QA cycle (partial)")
├─ p02  "pytest API"          one child per phase IN THIS RUN — total = tests selected
│   └─ fail-1 "<test id>"     one per failing test, created when the failure is seen
│       ├─ repro / rca / fix / validate      the debugger's and fixer's steps
└─ p05  "vitest API"
```

- **One plan per run, built from the instruction.** "run qa cycle" → all 12 phases.
  "run 2 tests from phase 2 and 3 from phase 5" → exactly `p02` (total 2) and `p05`
  (total 3) and NOTHING else. Phases not in this run are not on the tree.
- **Phase names are `p` + two digits** (`p02`, `p11`), labels are the phase titles below.
  A failure node is `fail-<n>` (never the test id — `/` and `::` would split the address);
  the test id is its label.

| phase | label |
|---|---|
| p01 | pytest unit | 
| p02 | pytest API |
| p03 | pytest long |
| p04 | vitest unit |
| p05 | vitest API |
| p06 | vitest react |
| p07 | vitest long |
| p08 | vitest headless |
| p09 | pytest hub |
| p10 | vitest hub |
| p11 | Playwright .md.ts gate |
| p12 | .md → .md.ts coverage |

## Who reports what

**Every `flow progress` / `flow test run` call targets the instance the person is
watching — the manager's own `FLOW_INSTANCE` — and carries `--subject none`.** Never
prefix them with the cycle instance's `FLOW_INSTANCE=qa-cycle`: that is the RUNNER's
target, passed with `--env`. (`--subject none` puts the tree on the footer; without it an
agent's report lands on its own worker row and the activity bar never shows it.)

| moment | who | call |
|---|---|---|
| before any test runs | manager | `flow progress report $ROOT label "QA cycle (partial)" --subject none` then ONE `plan` call: `flow progress report $ROOT plan "p02:2=pytest API,p05:3=vitest API" --subject none` |
| a phase runs | runner | `flow test run --activity $ROOT/pNN [--cwd ui] [--env K=V …] -- <runner cmd>` — it counts every test live, and its exit code is the verdict |
| a phase is RED | manager | for each failure in the summary's `failures`: `flow progress report $ROOT/pNN/fail-<n> label "<test id>" --subject none`; hand the ADDRESS to the debugger/fixer |
| a debug/fix step | debugger / fixer | `$ADDR/<step> label "<Step>"` to start it, `current <file:line>` while reading, `done "<one line>"` to end it (`cancel "<why>"` for a step that cannot be done) |
| a failure resolved | manager | `$ADDR done "fixed: <one line>"` + `inc --counter fixed` on the phase, OR `$ADDR fail "flagged: <reason>"` + `inc --counter flagged` |
| re-run after fixes | runner | the same `flow test run` command again — it starts the phase's counts over (`runs 2`) and keeps the failure nodes |
| phase gate | runner / manager | PASS: `flow test run` already ended the phase. RED: `flow progress report $ROOT/pNN fail "RED — N failing (N flagged)" --subject none`. BLOCKED: `fail "BLOCKED — <files>"` |
| cycle end | manager | `flow progress report $ROOT done "<summary>"` when every phase passed, else `fail "<summary>"` — e.g. `"1 PASS · 1 RED — 1 fixed, 1 flagged · report: <path>"` |

## `flow test run` — the verdict, machine-read

- The LAST line on its stdout is JSON: `verdict` (`PASS` / `RED` / `NO_VERDICT` /
  `MISMATCH`), `exit_code`, `planned`, `collected`, `passed`, `failed`, `skipped`,
  `failures` (`[{id, message}]`), `log` (the runner's full output). Record that line in
  cycle-state.md as the phase attempt's verdict. Never derive a verdict from the log.
- Exit codes: 0 PASS · 1 RED · 2 NO_VERDICT · 3 MISMATCH.
- **`MISMATCH` means the selection is not the plan** (planned 2, runner collected 5). Fix the
  selection and run again — never re-plan to fit what the runner happened to collect.
- pytest and vitest get live counts automatically (a reporter is added to the command).
  Any other runner still gets a verdict from its exit code, without live counts.
- Do not pass `--bail` / `-x` to a phase whose failures you need to count: a bail-1 run
  stops at the first failure and the plan's total can never be reached (it would read
  `MISMATCH`). Debug Mode (bail 1, one by one) is for a single failing test's loop.

## Selecting N tests from a phase

The selection must be deterministic and its count must equal the plan's total.

- **pytest** — collect, take the first N node ids, pass them as arguments:
  ```bash
  uv run pytest tests/api/ --collect-only -q 2>/dev/null | grep '::' | head -2
  flow test run --activity $ROOT/p02 -- uv run pytest -q <id1> <id2>
  ```
- **vitest** — list, pick N names from ONE file, select them with an anchored `-t`:
  ```bash
  cd ui && npx vitest list --project api tests/api/<file>.test.ts | head -3
  flow test run --activity $ROOT/p05 --cwd ui --env FLOW_INSTANCE=qa-cycle -- \
    npx vitest run --project api tests/api/<file>.test.ts -t "^(<full name 1>|<full name 2>|<full name 3>)$"
  ```
  Escape regex metacharacters in the names. `--env FLOW_INSTANCE=qa-cycle` is the runner's
  backend; progress still goes to the manager's instance.
- Phase 2 (`tests/api`, pytest) runs in-process (ASGI) and needs no backend instance.
  Phase 5 (vitest api) needs the cycle's `qa-cycle` instance (see qa-cycle.md Phase 5).

## Checks before you say the run is reported

- The plan announced lists exactly the phases and totals the instruction asked for.
- Every phase in the plan ended (PASS by `flow test run`, or RED/BLOCKED by you).
- Every `fail-<n>` ended (`done` fixed / `fail` flagged); every step under it ended.
- The root ended with the summary — that line is the receipt the person reads.
