---
id: 1b47dbc5-c2f8-4f10-ae07-02cb38197bc3
title: Worker interpreter resolution
tags:
- breadcrumb.test.worker_interpreter.rules
description: A worker is HANDED its interpreter as FLOWPAD_PYTHON — `uv run` resolves
  from the CWD and `python3`/bare `python` from PATH, and neither finds flow_sdk.
---

# Worker interpreter resolution

> Ground truth. Proven by RCA on 2026-08-12. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.worker_interpreter.rules
sites:
  - rel_path: "tests/cli/test_flow_diagnose_skill.py"
    line: 140
    note: "FAILING? read this tag's rules before editing - never assert on absence of the import error"
```

## Expected behavior

A skill script that does `import flow_sdk` must run under an interpreter that has
it, from **any** working directory. The worker never resolves one itself — it is
handed an absolute path as `FLOWPAD_PYTHON` and uses that verbatim.

This test runs Step 7's command, parsed out of the real `SKILL.md`, as a real
subprocess from a `tmp_path` that is not a uv project — the condition every
shipped install runs under.

## Internals

* **`apply_worker_env`** (`flow_sdk/builtin/agentic_process/cli_drivers/cli_worker_base_driver.py:419`)
  sets `env["FLOWPAD_PYTHON"] = sys.executable` at `:459`. It is the one chokepoint
  every spawn path calls — PTY (`agentic_process.py:1504`), inline print-mode turn
  (`agentic_process.py:3550`), and the headless drivers (`claude/driver.py:168`,
  codex `:141`, copilot `:127`) — so the var exists regardless of driver or mode.
  The backend's own `sys.executable` is by definition an interpreter that can
  import `flow_sdk`.

* **`ClaudeCLIWorker.build_env`** (`claude/cli_worker.py:79`) starts from
  `os.environ` and overlays `context.env_vars`, so the worker also inherits
  whatever makes `flow_sdk` importable in the backend (this matters on dev
  instances, where `instance_ctl.sh:253` launches via `uv run` and `sys.executable`
  is a bare uv-managed interpreter rather than a venv).

* **PATH is not a reliable substitute.** `flow_cli_env_path`
  (`cli_worker_base_driver.py:546`) prepends `Path(sys.executable).parent`, but the
  capability bin folder is prepended *after* it at spawn time —
  `build_worker_spawn_env` (`:1041`) and `agentic_process.py:1608`, with a comment
  explaining that the capability folder must outrank the venv pin. So a bare
  `python` can resolve to Homebrew's. Only an absolute path is immune.

* **`restart_payload_from_cli_options`** (`:894`) pops `FLOWPAD_PYTHON` at `:920`.
  The value is derived from the install location, so hashing it would flip
  `restart_required` on every process after an upgrade.

* **`report.py`** (`.claude/skills/flow-diagnose/report.py:50`) guards its
  `from flow_sdk._compat import UTC` and exits naming both the interpreter it got
  and `$FLOWPAD_PYTHON`.

* **`SKILL.md`** states the rule at `:53` and uses `"$FLOWPAD_PYTHON"` at all three
  call sites: the port probe `:86`, the backend start `:466`, and Step 7's reporter
  `:537`.

* **Worker cwd** is `Path.cwd()` of whoever builds the process
  (`flow_sdk/cli/commands/diagnose_cmd.py:252`). Via the CLI that is your shell;
  via the UI it is the *backend's* cwd — which is why a UI-launched diagnose on a
  dev box runs inside the checkout and cannot reproduce this at all.

## Invariants

* **Assigned, never `setdefault`-ed.** `FLOWPAD_PYTHON` is derived machine state,
  not launch config. `apply_worker_env` receives a process's persisted
  `cli_config["env_vars"]`, so a `setdefault` would let a path from a previous
  install survive an upgrade and silently reintroduce this bug.

* **Stripped from the restart payload.** Add it back to the hash and every user
  gets a phantom "restart required" glow after upgrading.

* **No shipped skill runs Flowpad code through `uv run`, `python3`, or bare
  `python`.** `uv run` ignores PATH and resolves from the cwd; `python3.exe` does
  not exist in a Windows venv; bare `python` loses to the capability folder.

* **`report.py`'s guard must never contain the literal `diagnosis_id`.** The runner
  detects completion by regex-scraping that token out of the stream
  (`diagnose_cmd.py:27`), so a failure message carrying it would make a dead run
  read as complete.

* **The test asserts on *reaching argparse*, not on the absence of
  `ModuleNotFoundError`.** A `SystemExit` carrying a string prints only that
  string, so once the guard landed an absence-assertion would go green on a
  broken interpreter purely because the wording changed. Only a successful import
  can produce `the following arguments are required: --title`.

* **The test drops `VIRTUAL_ENV`.** It runs under `uv run pytest` from the
  checkout, so it carries one pointing at `.venv` — the single thing that would
  let `uv run` find Flowpad from an unrelated directory. A shipped uv *tool*
  install has none. Keeping it would test the developer's tree and pass while
  every real install fails.

## Failure modes

**The on/off lever.** In `SKILL.md:537` replace `"$FLOWPAD_PYTHON"` with
`uv run python`. `report.py` dies on its first line and nothing is recorded:

```
File "...\.claude\skills\flow-diagnose\report.py", line 49, in <module>
    from flow_sdk._compat import UTC
ModuleNotFoundError: No module named 'flow_sdk'
```

Put it back and the same command records a real `diagnosis_id`. Verified in both
directions at the unit layer and end-to-end against a live instance.

A second, independent lever: delete `:459`. The test then fails with
`Step 7 invokes $FLOWPAD_PYTHON, which the worker environment does not define`.
Two levers failing two different ways is what makes this a cause and not a
coincidence of the test environment.

**Why this hid for four weeks.** Every clean run in the analysed sample had a cwd
inside a flowpad checkout, which *is* a uv project, so `uv run` resolved `.venv`
and the step passed. Every failing run had a cwd outside one — which is where all
real users are. Reproducing it from the repo root is impossible; use a temp dir.

**What it cost.** 0/4 packaged runs recorded on the first attempt; one never
recorded at all; and in FLOWPAD-1974 the agent — told never to end its turn
without the JSON *and* not to fail if the step errored — hand-wrote a
`diagnosis_id`, which `_extract_report_result` (`diagnose_cmd.py:27`) adopted
unchallenged. That scrape still validates nothing.

**Adjacent trap, same step.** In PowerShell, `--details` needs a single-quoted
here-string **and** `-replace '"', '\"'`. Windows PowerShell 5.1 does not escape
embedded quotes for native commands: without the replace the block arrives as 5
arguments with the quotes stripped and argparse rejects it
(`unrecognized arguments: is up and running,data:true}`); with it, 1 argument
intact. Bash needs neither.
