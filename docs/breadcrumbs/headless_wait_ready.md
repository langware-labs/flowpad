---
id: fc027431-5f49-45d1-bbae-b3dd71ec9570
title: Headless waitForReady waits until no turn holds the slot
tags:
- breadcrumb.test.headless_wait_ready.rules
description: For a headless (pty_mode false) process, the SDK's waitForReady() resolves
  only when !isBusy(this), the same wire busy that the backend's is_turn_busy derives
  and that its switch-mode/restart 409 keys on. A switchMode right after it is then
  never refused as "a turn is in flight".
---
# Headless waitForReady waits until no turn holds the slot

> Ground truth. Proven by the fix 517e107a2 (PR #814, 2026-11-10): the bound test failed with a 409 without it and passes with it. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.headless_wait_ready.rules
sites:
  - rel_path: "ui/tests/long_tests/wait_for_ready_headless_switch.test.ts"
    line: 18
    note: "FAILING? read this tag's rules before touching waitForReady's headless gate"
```

## Expected behavior

`createProcess({pty_mode: false, launchPrompt: …})`, then `await ap.waitForReady()`, then
`await ap.switchMode(WorkerMode.Interactive)` succeeds while the seeded launch turn
is still running, because `waitForReady` waited for that turn to end.

## Internals

* `AgenticProcess.waitForReady()` (`ts_sdk/src/process/agentic-process.ts:2344`) polls a
  transport-aware `ready()`:
  * live PTY: `isReadyForInput(this)` (`ts_sdk/src/process/agentic-types.ts:482`);
  * headless (**the fix**, `agentic-process.ts:2355`): `!isBusy(this)`
    (`agentic-types.ts:457`, `p.busy === true`).
* Before the fix, headless was `!this.pty_mode || …`, which is always ready. The comment
  said a headless process "is always ready to accept the next turn", and that holds for
  a prompt (it enqueues) but not for a mode switch.
* The backend's `_reject_if_turn_in_flight()`
  (`flow_sdk/builtin/agentic_process/agentic_process.py:2222`) answers 409 "a turn is in
  flight" for `switch-mode` (both directions) and `restart` whenever `is_turn_busy(self)`
  (`status_predicates.py:109`). The wire `busy` comes from the same predicate.

## Invariants

* `waitForReady()` resolving means a `switchMode` / `restart` sent next is not refused
  for a busy turn. The SDK gate and the backend 409 read one predicate (`busy`).
* Do not swap the headless gate for `isReadyForInput`. A fresh or headless-idle process
  is ready there by design, which is a separate question from "no turn in flight".

## Failure modes

* **Before the fix:** `waitForReady()` returned at once, and `switchMode` failed with
  "Request failed with status code 409".
* The test is gated behind `RUN_PTY_STRESS` (via `stressDescribe`) and spawns a real
  claude worker against `FLOW_INSTANCE`. A login or quota failure there is environmental.
* `waitForReady` needs a watched process (`watchProcess: true`). Without the watch,
  `busy` never updates and it times out.
