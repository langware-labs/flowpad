---
id: fae4a961-d269-4c34-ba55-a9f4c49bb889
title: Hub sign-in survives a hub socket reconnect
tags:
- breadcrumb.test.hub_signin_reconnect.rules
description: A box is signed in to FlowPad only while the hub WS is VERIFIED, and
  that was asked once at boot -- so the ~10-minute 1006 reconnect, or a login after
  boot, silently reset it and every non-public hub LLM endpoint (an org allocation)
  was refused "this box is not logged in to the hub". A reconnect must keep it; a
  login must re-ask.
---
# Hub sign-in survives a hub socket reconnect

> Ground truth. Proven by RCA on 2026-10-04. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.hub_signin_reconnect.rules
sites:
  - rel_path: "tests/unit/test_hub_signin_survives_ws_reconnect.py"
    line: 86
    note: "FAILING? a hub socket reconnect forgot who the hub named, signing the box out of every hub-funded LLM endpoint - read this tag's rules before touching HubWebSocketManager._run_forever/_set_state(verified=...) or core.status.hub_status"
```

## Expected behavior

A box whose hub user has been confirmed stays "signed in to FlowPad" for as long as it
holds the same credentials -- across any number of hub socket drops and reconnects. A
login made after the backend booted makes the box signed in once the hub names the user.
While signed in, the box's non-public hub LLM endpoints (personal or org allocations,
e.g. an allocation granted through an organization) are eligible funding sources.

## Internals

- **What "signed in" means.** `core.status.hub_status()` (`flow_sdk/core/status/build.py:162`)
  returns `SIGNED_IN` only when `hub_ws_manager.is_verified` (`:184`) -- the hub answered
  "who am I" over the authenticated socket and named the locally stored user. A stored
  credential alone is `OFFLINE`; a refused one is `REJECTED`. Introduced by the status
  layer (`e0025e9de`).
- **Who reads it for funding.** `llm_source._hub_signed_in()`
  (`flow_sdk/builtin/agentic_process/cli_drivers/llm_source.py:364`) feeds
  `_endpoint_sources`, which marks every non-public hub endpoint ineligible with
  `"this box is not logged in to the hub"` (`:283`) when it is false; the constraint path
  does the same (`:455`). Wired in by funding-on-status (`34de0ed25`), replacing the old
  "a request would carry a key" check.
- **Where verification is asked.** `HubWebSocketManager.verify_current_user()`
  (`flow_sdk/cloud_client/ws_client.py:723`) opens its own short socket, sends a
  `direct_resource_type="user"` request and sets `_verified=True` when the hub's user id
  matches `get_user()`. Callers: boot (`flow_sdk/server/app.py:736`), login
  (`flow_sdk/cli/auth/cloud_login.py:300`, after `restart(wait_connected=True)`), and the
  manual `POST /api/v1/cloud/ws/verify`.
- **What forgets it.** `is_verified` is `is_connected and _verified` (`ws_client.py:430`),
  so it is already false while the socket is down. `_verified` itself is cleared by
  `request_stop()` (`:526`, reached from `stop()`/`restart()` -- logout and login), and
  by the loop on auth refusal/login-required. The reconnect loop in `_run_forever`
  (`:575` CONNECTING, `:676` DISCONNECTED after a non-auth close) must NOT clear it.

## Invariants

1. A reconnect with the same credentials never changes `_verified`. Same key can only name
   the same user; a refused key ends the loop as `AUTH_REJECTED` (1008 / HTTP 401/403),
   which is the path that clears it.
2. Every path that can change WHO is logged in (`stop()`/`restart()`: login, logout) clears
   `_verified`, and every path that completes a login asks `verify_current_user()` again.
   Boot is one such path; login is the other.
3. Nothing polls verification. It is asked on identity change only, not per reconnect and
   not on a timer.

## Failure modes

- **Signed out every ~10 minutes.** Production drops the hub socket on a ~10-minute
  cadence (`Hub WS listener closed: code=1006`). With a reset in the reconnect loop, a box
  that verified at boot is signed out at the first drop and never re-verified. Symptom:
  `GET /api/v1/cloud/status` shows `logged_in: true`, `hub_ws_status: connected`,
  `hub_ws_verified: false`; spawns fail with `claude has no usable LLM source: ... <endpoint>:
  this box is not logged in to the hub`; the UI shows "Default assistant not funded" and
  "could not switch to terminal".
- **Signed in after boot, never verified.** Logging in after the backend started (fresh
  install, re-login) runs `restart()`, which clears `_verified`; without a verify after
  it, the box is signed out from its first minute.
- **Proof (2026-10-04, tart VM, flowpad 0.2.187, user gadi+72 with an org allocation):**
  `POST /cloud/ws/verify` → the allocation went eligible; the next real 1006 reconnect →
  `hub_ws_verified: false` and the allocation refused again. In the unit test, removing the
  two resets in `_run_forever` turned it green; restoring them turned it red.
- **Not this bug:** a box with no hub credential at all (`SIGNED_OUT`), or a refused one
  (`REJECTED`, `hub_ws_status: auth_rejected`) -- those are real sign-outs.
