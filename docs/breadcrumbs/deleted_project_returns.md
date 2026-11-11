---
id: 199aaf2b-4754-4d3f-b949-89948a5e0ad0
title: A deleted project must not be re-mirrored from the hub
tags:
- breadcrumb.test.deleted_project_returns.rules
description: Deleting a project deletes its conversations locally but the hub keeps
  them; the next catch-up re-synced a message carrying a project-<id> attachment and
  the FLOWPAD-2199 compat mirror (mirror_referenced_projects) hydrated the missing
  project from the hub, so the project the user just deleted came back — and held
  its name.
version: 2
---
# A deleted project must not be re-mirrored from the hub

> Ground truth. Proven by RCA on 2026-10-28. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.deleted_project_returns.rules
sites:
  - rel_path: "tests/hub_tests/test_deleted_project_stays_deleted.py"
    line: 26
    note: "FAILING? Read this tag's rules before editing; a project the user deleted must not be hydrated back from the hub by its conversation's messages. Needs the local hub and two identities."
```

## Expected behavior

After `Project._delete_with_children`, the project stays gone: no Project row reappears when its conversation is caught up from the hub, however many messages in it reference `project-<id>`. A Project row is created on this machine only by something the user did on purpose, never as a side effect of receiving a message.

## Internals

* **What the delete takes.** `Project._delete_with_children` (`flow_sdk/builtin/project.py:3635`) destroys the project and every record whose `project_id` is the project, including its conversations and their messages. That is local only; the **hub keeps its conversation and messages**, and (not checked) its project row.

* **The catch-up that brings the messages back.** `_fetch_conversation_messages` (`flow_sdk/app/actions/flow_message_action.py:3317`) lists the hub's messages, skips the ones already current, and for the rest calls `_process_single_hub_message` (`flow_message_action.py:1918`, called at `:3398`). The messages are gone locally after the delete, so they all count as new. The live path for the same message is `materialize_flow_message` (`flow_sdk/app/actions/materialize_flow_message.py:187`).

* **The culprit (removed).** `mirror_referenced_projects` — a FLOWPAD-2199 backward-compatibility shim marked "remove in FLOWPAD-2200" — was called from both paths. For each `project-<id>` TYPE\_ID attachment whose project had no local row it called `Project.hydrate_from_hub` (`project.py:2568`) → `HubProxy.call("GET", PROJECT, <id>)` → `materialize_remote_membership_entity`. For a message about a project the user had just deleted, "no local row" was indistinguishable from "never received it".

* **It needs the hub to still say yes.** The `GET /graph/project/<id>` answered `403` while the project had not been shared (nothing came back), and `200` once it had been. A project the hub no longer holds, or that the user is no longer a member of, is not resurrected.

## Proof (the on/off switch)

The lever is the single call `await Project.hydrate_from_hub(...)` inside `mirror_referenced_projects`.

* Two disposable instances (`instance_ctl.sh launch`) against the local hub, project shared from one to the other, then deleted on the receiver and a new message sent referencing it:

  * hydrate neutralised → project row count after the message: `0`.

  * hydrate restored → `1`. The log shows `[RCA-PROBE] mirror_referenced_projects hydrating <id>` followed by `GET .../graph/project/<id> "HTTP/1.1 200 OK"`.

* The test fails with the shim in place and passes with it removed (shim code stashed back in, run, stash popped).

## Invariants

1. Nothing on the message-receive path (`_process_single_hub_message`, `materialize_flow_message`, `_fetch_conversation_messages`) creates a Project row from a reference in a message.
2. A Project row appears on this machine only through an explicit user action: opening a share link (`Project.resolve_open`, `project.py:2594`, and `open_action.py:96`), a launch (`launch_action.py:79`), installing from the review popup, or cloning.
3. Deleting a project that has a conversation must not be undone by that conversation syncing.

## Failure modes

* **Test fails with** **`deleted project came back from the hub`**: something on the receive path hydrates projects again. Look for new callers of `Project.hydrate_from_hub` outside the user-action list above.

* **Test is skipped**: `tests/hub_tests` needs the local hub at `localhost:8093` and two distinct identities. `pyproject.toml` pins `FLOWPAD_HUB_URL` to `127.0.0.1:9` for the whole suite, so run with `-p no:env` and set `FLOWPAD_HUB_URL`, `FLOWPAD_CLOUD_USER_EMAIL`/`FLOWPAD_CLOUD_USER_PASSWORD`, and `ALICE_EMAIL`/`BOB_EMAIL` (different accounts, or the tier skips with "needs two distinct identities"). The tier does not run in CI.

* **Accepted trade-off of the fix**: an invite sent from Flowpad v0.2.183 or older (before 2026-10-02) carries no project in the bundle, and the shim used to pre-create the row so the chat chip's "Install project" worked. Now that button stays at "waiting" for such an invite. The email link still works (`IncomingDeepLink.tsx:202` hops through `project/<id>/open`, which hydrates on click). The user decided not to handle old senders.

* **Not proven**: whether deleting a project also removes it on the hub, and what the hub does for a user who deleted a project they own versus one shared with them.

