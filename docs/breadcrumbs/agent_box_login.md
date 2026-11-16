---
id: 3eda31b5-2d75-4447-8462-56313af703ec
title: An agent's box signs in as its principal
tags:
- breadcrumb.test.agent_box_login.rules
description: Hub 0.29 answers /current-user with empty data for an agent Identity;
  a box that only reads it never signs in, so it reads no mail and its deploy's allocation
  bind (409) used to abort the deploy.
---
# An agent's box signs in as its principal

> Ground truth. Proven by RCA on 2026-11-16. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.agent_box_login.rules
sites:
  - rel_path: "tests/unit/test_agent_box_login_principal.py"
    line: 50
    note: "FAILING? an agent box that never signs in reads no mail and refuses its allocation - read this tag's rules first"
  - rel_path: "tests/long_tests/test_cloud_deploy_activity_live.py"
    line: 241
    note: "FAILING? an agent box that never signs in reads no mail and refuses its allocation - read this tag's rules first"
  - rel_path: "ui/tests/manual_regression/hub_home/first_agent_email.md.ts"
    line: 55
    note: "FAILING? an agent box that never signs in reads no mail and refuses its allocation - read this tag's rules first"
```

## Expected behavior

A deploy with a main agent boots a box and signs it in to the hub as the agent's **Identity** (a node-bound key the
hub mints). Signed in, the box polls the agent's hub mailbox (`cloud_email` source) and is bound to the deployment's
LLM endpoint or token allocation. Funding is a warning, never a gate: an unfunded deploy still completes, and its
readiness step says "No LLM funding for …".

## Internals

* The hub signs the box in over loopback: `GET /auth/login_callback?flowpad-api-key=…`
  (`flow_sdk/server/routes/auth.py`, `login_callback`) → `validate_api_key_async` (`flow_sdk/cli/auth/hub_login.py`)
  → `FlowpadClient.get_user` (`flow_sdk/cloud_client/client.py`).
* Hub `release/v0.29` (FLOWPAD-2353, hub commit `dd63a41c6`, staging 0.29.233) split person from principal:
  `/current-user` answers an Identity with `{"status": "SUCCESS", "message": "Not a person", "data": null}`, and
  `/current-principal` names it (`type: identity`). Older hubs dress the Identity as a user on `/current-user`.
* `get_user` asks `/current-user`, and on empty data `/current-principal`. The hub WebSocket verify
  (`HubWebSocketManager.verify_current_user`, `flow_sdk/cloud_client/ws_client.py`) does the same with the
  `current-user` / `current-principal` actions.
* Hub side (`flowpad-hub`, `flowpad/hub/app/services/sandbox_deploy.py`, `_bind_allocation`): after placing the
  machine, a deployment with its own allocation is bound with `node.setup_llm_endpoint`. The box answers 409
  ("box is not logged in to the hub; log it in before binding an LLM endpoint",
  `flow_sdk/builtin/agentic_process/cli_drivers/hub_endpoint_binding.py`, `bind_hub_llm_endpoint`) when its login did not land.
  `_bind_allocation` logs that refusal and goes on; the next workspace-ready binds the box.

## Invariants

* A box's login must accept both hub answers: a person on `/current-user`, or empty data there and the principal on
  `/current-principal`.
* A refused allocation bind never aborts a deploy (the deploy contract: funding is a warning).
* An agent box that is not signed in polls its mailbox unauthenticated (401), and its `cloud_email` sources latch
  `config_error`, which stops polling until a sync un-latches them.

## Failure modes

* Box login reads only `/current-user` → `TypeError: argument of type 'NoneType' is not iterable`, logged by the box
  as `login_callback failed: …`; the hub reports `logged_in: false`, `login_detail: "box configuration failed at
  login: login_callback returned HTTP 400"`. Then:
  * `first_agent_email.md.ts`: the wizard goes live, the mail reaches the hub mailbox in seconds, but the box's
    `channel_setup` items stay `[]` (every poll is a 401).
  * `test_an_unfunded_deploy_is_still_accepted_with_a_warning`: `_bind_allocation` gets the box's 409 and the deploy
    ends `failed: hub error 500: deployment failed: box is not logged in to the hub; …`.
* Proof (2026-11-16): on a staging E2B box (template 0-2-263), installing the fixed `client.py`/`ws_client.py` made
  the agent login land, the box list "Opening hours" and the agent reply; restoring the old files brought the
  `NoneType` failure back. On the local hub, an E2B box (which cannot reach the hub, so never signs in) deployed with
  a $0 allocation: with the `_bind_allocation` fix it completed with the funding warning; without it, it failed with
  the 409 message.
* A green run of the two live tests needs a box built from the fixed code (a new E2B template / gcp_vm release) and
  a hub with the `_bind_allocation` fix; the released template keeps failing on hubs at 0.29.
