---
id: 4b5e6979-4f2c-41b8-8f8e-5c34f0e2fa3e
title: A spawn refused while a prompt is prepared answers a typed refusal
tags:
- breadcrumb.test.prompt_spawn_refusal.rules
description: A WorkerSpawnError raised in _http_prompt's setup (an unfunded harness,
  a size with no mapping) must release admission, latch the start failure and return
  launch_refusal, a typed 400 for a config error. It must not escape as a 500 "Internal
  server error".
---
# A spawn refused while a prompt is prepared answers a typed refusal

> Ground truth. Proven by the fix 5f401a15b (PR #814, 2026-11-10) after the bound test's codex row failed with "HTTP error 500". Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.prompt_spawn_refusal.rules
sites:
  - rel_path: "ui/tests/long_tests/process_hook_acceptance.test.ts"
    line: 24
    note: "FAILING? on a 500 from prompt, read this tag's rules before touching _http_prompt's WorkerSpawnError branch"
```

## Expected behavior

`process.prompt(...)` on a headless process whose worker cannot be spawned (for
example codex/copilot on a device login asked for an unmapped size such as `sm`) gets
a typed refusal the person can act on. The process is latched FAILED with its
`launch_failure`.

## Internals

All in `flow_sdk/builtin/agentic_process/`:

* `AgenticProcess._http_prompt()` (`agentic_process.py:4304`) takes admission
  (`try_admit_prompt`, `:4365`), then prepares the turn in one `try` block (context,
  `driver.stream_worker(self)`, `WorkerTurns`, `register_prompt_worker`). The turn's
  env, including funding and size mapping, is resolved there.
* `WorkerSpawnError` (`cli_drivers/cli_worker_base_driver.py:396`) means "this worker
  cannot spawn its CLI".
* **The fix** (`agentic_process.py:4400`): `except WorkerSpawnError` in that setup block
  calls `release_prompt_admission`, then `latch_spawn_failure(self, e)`
  (`cli_worker_base_driver.py:1512`, which sets status FAILED and the start-failure
  latch, then saves), then returns `launch_refusal(str(e), self.launch_failure)`
  (`launch_health.py:86`): **400** when the classified health is `config_error`, 503
  otherwise.
* This is the same latch the in-turn path already used (`except WorkerSpawnError` inside
  `_run_turn`, `:4470`). Before the fix, a refusal during setup fell into
  `except BaseException: … raise`, which produced a 500.

## Invariants

* A spawn refusal is typed and latched wherever it is raised: before the turn
  (this branch) or inside it.
* Admission is always released on a setup failure, so the next prompt is not refused
  409 "another prompt turn is already in flight".

## Failure modes

* **Before the fix:** the codex row (then run with `cli_config.model = 'sm'`) failed with
  "HTTP error 500".
* **The test no longer triggers the refusal.** In #754 it pins `model: 'sm'` to
  claude_code only ("codex/copilot on a device login refuse an unmapped size"). A 400
  naming a size or funding problem means the latch is working and the test's config is
  wrong. A 500 means this branch regressed.
