---
id: 35bc6735-fdea-4467-bfdb-19dca62eb0ee
title: What evidence may write a harness login state
tags:
- breadcrumb.test.harness_login_state.rules
description: login_state is written from evidence of unequal strength, and both directions
  have burned us. An undetermined probe was recorded as signed out; separately, a
  probe that only checks a credential EXISTS overturned a refusal the harness itself
  made, so the login modal opened on "Not logged in" and showed a green "Signed in".
---

# What evidence may write a harness login state

> Ground truth. Proven by RCA on 2026-08-30 (undetermined probe → signed out) and
> 2026-08-31 (presence-only probe → signed in). Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.harness_login_state.rules
sites:
  - rel_path: "tests/unit/test_capabilities/test_harness_login_state_mapping.py"
    line: 43
    note: "FAILING? an undetermined auth probe is being recorded as signed out - read this tag's rules before touching _mirror_probe_to_login_state or the probe status mapping"
  - rel_path: "tests/unit/test_capabilities/test_harness_login_state_mapping.py"
    line: 73
    note: "FAILING? the harness's own 'Not logged in' refusal is no longer recorded - read this tag's rules before touching report_signed_out_action"
  - rel_path: "tests/unit/test_capabilities/test_harness_login_state_mapping.py"
    line: 137
    note: "FAILING? a presence-only auth probe is overturning a sign-out the harness itself reported - read this tag's rules before touching _mirror_probe_to_login_state or probe_claude_auth's verified flag"
  - rel_path: "tests/unit/test_capabilities/test_harness_login_state_mapping.py"
    line: 219
    note: "FAILING? a user-invoked Test can no longer clear a recorded refusal - read this tag's rules before touching auth_status_action's force flag"
```

## Expected behavior

FlowPad may tell the user they are signed out **only when it asked and was told
so**. Failing to reach an answer is not an answer.

And the converse, which cost us the same bug pointing the other way: FlowPad may
tell the user they are signed **in** only on evidence that the credential
actually WORKS. Evidence here is not all one strength, and that ranking is the
rule:

| Evidence | Proves | Strength |
|---|---|---|
| A turn refused with "Not logged in · Please run /login" | the credential does not work | **strong** — the harness tried it |
| A completed device login | the credential works | **strong** |
| `claude auth status` says `loggedIn: true` | a credential is stored | **weak** — presence only |
| `claude auth status` says `loggedIn: false` | no credential is stored | strong (absence is conclusive) |

A weak positive may set the state when nothing stronger contradicts it. It may
never overturn a strong negative.

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

* **The probe measures presence, not validity.** `claude auth status` reads the
  credential off disk and never contacts the server — proven: with
  `ANTHROPIC_BASE_URL` pointed at a dead port it still answers `loggedIn: true`,
  and with a deliberately invalid `ANTHROPIC_AUTH_TOKEN` it answers
  `{"loggedIn": true, "authMethod": "oauth_token"}` while the SAME binary answers
  a real turn with `Not logged in · Please run /login`. So `probe_claude_auth`
  (`auth_probe.py:159`) reports its `LOGGED_IN` with `verified=False`; only
  `LOGGED_OUT` is verified, because absence cannot be a working credential.

* **The refusal is recorded, and it sticks.** `Capability.login_denied`
  (`capability.py`, `Persist.FALSE` like the rest of the `login_*` block) is set
  by `report_signed_out_action` — which the frontend calls from
  `useHarnessLoginOnAuthError` (`ui/src/components/harness-login/use-harness-login-on-auth-error.ts`)
  when `worker_status_detail` carries the refusal. While it is set,
  `_mirror_probe_to_login_state` refuses to promote an *unverified* `LOGGED_IN`
  back to `AUTHENTICATED`. Without it the modal's own re-probe on open restored
  the green badge it had just corrected, one render later.

* **`force` is the user's way out.** `auth_status_action(force=True)` drops the
  recorded refusal before probing, and only the user-invoked **Test** button
  passes it (`HarnessLoginModal.tsx` → `Capability.authStatus(force)`). Without
  it a harness the user re-authorised OUTSIDE FlowPad — `claude /login` in their
  own terminal — would read as signed out forever, since no turn had yet proven
  the new credential and the probe alone is not allowed to.

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
7. **A presence-only positive never overturns a witnessed refusal.** An
   *unverified* `LOGGED_IN` may write `AUTHENTICATED` only while `login_denied`
   is false. This qualifies invariant 1: `LOGGED_IN` → `AUTHENTICATED` is
   conditional, not unconditional.
8. **Only stronger evidence clears `login_denied`.** A completed device login
   (`_apply_login_session` on `AUTHENTICATED`), a probe that is genuinely
   `verified`, or an explicit user-invoked `force`. Never a background probe.
9. **The silent re-probe and the Test button are not the same call.** The modal's
   on-open refresh must never pass `force`; the Test button must. Collapsing them
   reintroduces the bug, because on-open is exactly when the stale positive won.

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

* **Trusting `claude auth status` as a login check.** It is a presence check
  wearing a login check's name. Any code that treats its `loggedIn: true` as
  proof the harness can run — a startup gate, a footer, a launch precondition —
  reintroduces this. The tell is the mirror image of the older bug: the user is
  told they are signed in while every turn fails with "Not logged in".

* **Making the probe validate instead.** Rejected: `auth-status` is documented as
  the cheap, no-network check, and the vendor CLI exposes no validate command —
  the only way to test a credential is to spend a turn on it. Rank the evidence
  instead of strengthening the weak source.

* **Clearing `login_denied` on any probe to "unstick" a user.** That is the bug
  again with a friendlier motive. The unsticking path is `force`, gated on an
  explicit user action.

* **Believing the test passed because it ran.** The test asserts the probe really
  returned `NOT_INSTALLED` before checking what it was filed as. Without that
  guard it goes green whenever the environment happens to resolve the CLI, and
  proves nothing.
