---
title: Signed-in harness reported as signed out
tags: [breadcrumb.test.harness_login_state.rules]
description: The footer warned "a coding agent CLI is installed but not signed in" over a CLI that was both. The auth probe distinguishes four verdicts, but the capability mirrored them into two — filing NOT_INSTALLED and UNKNOWN as login_state "idle", the same value a real sign-out writes. A probe that never reached a verdict was being reported as one.
---

# Signed-in harness reported as signed out

> Ground truth. Proven by RCA on 2026-08-30. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.harness_login_state.rules
sites:
  - rel_path: "tests/unit/test_capabilities/test_harness_login_state_mapping.py"
    line: 41
    note: "FAILING? an undetermined auth probe is being recorded as signed out - read this tag's rules before touching _mirror_probe_to_login_state or the probe status mapping"
```

## Expected behavior

FlowPad may tell the user they are signed out **only when it asked and was told
so**. Failing to reach an answer is not an answer.

The cost is asymmetric, and that asymmetry is the whole rule. Telling a user
their working, authenticated harness is signed out sends them to re-run a login
they do not need, and the message persists — nothing re-probes on its own. Saying
nothing costs a warning the user did not need to see. Silence is the cheaper
mistake, so an undecided probe stays silent.

## Internals

* **The driver layer already keeps four verdicts apart.**
  `WorkerAuthStatus` (`flow_sdk/builtin/agentic_process/cli_drivers/auth_probe.py:39`)
  is `LOGGED_IN` / `LOGGED_OUT` / `NOT_INSTALLED` / `UNKNOWN`, and
  `docs/interface/cli-drivers.md:192` pins the contract in words: `UNKNOWN` is
  "never conflated with `LOGGED_OUT`". The drivers honour it.

* **The capability layer flattened them into two.** `auth_status_action`
  (`flow_sdk/builtin/capability.py:439`) mirrored the probe with
  `"authenticated" if status == "logged_in" else "idle"` — so `NOT_INSTALLED`,
  `UNKNOWN` and `LOGGED_OUT` all landed on `idle`. The mapping existed in **two
  copies** in that one method, one per branch, free to drift.

* **`idle` is the footer's accusation.** `isHarnessLoginRequired`
  (`ts_sdk/src/react/hooks/useWarnings.ts:39`) warns when every installed harness
  carries a truthy `login_state` and none is `authenticated` — so *any*
  non-authenticated value, `idle` or `error` alike, renders as
  `createHarnessLoginWarning` (`ts_sdk/src/models/UserWarning.ts:215`): "A coding
  agent CLI is installed but not signed in."

* **Three real ways the probe reaches no verdict.** `probe_claude_auth`
  (`auth_probe.py:159`) returns `UNKNOWN` when stdout is not JSON carrying
  `loggedIn` — which is also where an older CLI without the `auth` subcommand
  lands; `probe_worker_auth` (`auth_probe.py:272`) returns `UNKNOWN` on
  `TimeoutExpired` (`PROBE_TIMEOUT_SECONDS = 5.0`, `auth_probe.py:33`) and on
  `OSError`; and it returns `NOT_INSTALLED` whenever
  `resolve_worker_probe_context` (`cli_worker_base_driver.py:1093`) finds no
  executable, because `worker_bin_folder` (`:1051`) reads only the folder
  capability discovery recorded and never falls back to a PATH lookup.

* **Availability and login come from different clocks.** `available` is served
  from a persisted row (`last_setup ?? last_test ?? last_check`), while
  `login_state` comes from a live probe and is `Persist.FALSE`
  (`capability.py:96`). When they disagree you get the exact contradiction the
  user sees: installed, per the saved row; not signed in, per the live probe.

* **Nothing re-probes.** `capability.authStatus()` has three call sites, all in
  `ui/src/components/harness-login/HarnessLoginModal.tsx`. There is no startup
  gate, despite `useWarnings.ts` and `capability.py` both referring to one. So a
  wrong verdict stands until the user opens the modal — which the footer warning
  itself is the click path to (`warnings-popover.tsx:232`).

## Invariants

1. **Only a decided verdict writes `login_state`.** `LOGGED_IN` → `AUTHENTICATED`,
   `LOGGED_OUT` → `IDLE`. `NOT_INSTALLED` and `UNKNOWN` write nothing.
2. **An undetermined probe moves the field in neither direction.** It must not
   assert a sign-out, and must not clear a real one — it is evidence about the
   probe, not about login.
3. **A login in flight is untouchable.** `AWAITING_USER` / `STARTING` short-circuit
   before any mirroring (`capability.py:416`), so a background probe cannot
   stomp on a device login the user is completing.
4. **One mapping, one place.** `_mirror_probe_to_login_state`
   (`capability.py:396`) is the only code that turns a probe into a login state.
   Both branches of `auth_status_action` call it. Do not re-inline it.
5. **`login_state` is `DeviceLoginState`, not a string.** The enum
   (`auth_probe.py:46`) is a `str` subclass, so the wire format is five plain
   strings and `ts_sdk/src/entities/capability.ts:32` matches it exactly.
6. **Broadcast only on change**, so a repeated identical probe emits no WS frame.

## Failure modes

* **Flattening the verdicts again.** Any `else: "idle"` reintroduces the bug
  wholesale. The tell is a user reporting "it says I'm signed out but I'm not",
  with a harness that still launches agents fine.

* **Giving the undecided case its own truthy state.** Writing `ERROR` instead of
  leaving the field alone does **not** help: invariant 2 exists because
  `isHarnessLoginRequired` warns on *any* truthy non-authenticated value, so
  `ERROR` reprints the same wrong sentence. An honest "could not check" message
  needs a frontend branch as well as a backend state — it is a separate change.

* **Fixing this in discovery instead.** Retaining a known-good bin folder when a
  sweep comes back empty was tried and rejected: `_discover_one` is generic, so
  it changes behavior for every capability kind, and
  `docs/interface/cli-drivers.md:192` documents "no discovered folder ⇒
  `NOT_INSTALLED`" as intended. The defect is the mapping, not the sweep.

* **Widening the probe timeout to make `UNKNOWN` rarer.** Banned. A probe that
  needs more than 5s is itself the signal; the repo's timeout rule applies.

* **Believing the test passed because it ran.** The test asserts the probe really
  returned `NOT_INSTALLED` before checking what it was filed as. Without that
  guard it goes green whenever the environment happens to resolve the CLI, and
  proves nothing.

<!-- flowpad:capsule identity
version: 1
data:
  id: 35bc6735-fdea-4467-bfdb-19dca62eb0ee
flowpad:endcapsule identity -->
