---
id: 207631fb-c229-4f99-92e1-b8600aeaaf9f
title: A mailbox on someone else's agent is refused as FOREIGN_TARGET
tags:
- breadcrumb.test.foreign_agent_mailbox.rules
description: Allocating a mailbox for an agent whose hub row belongs to another account
  must raise AgentMailboxError FOREIGN_TARGET (403) and leave agent.remote False.
  share() now reports that case as HubError(ID_TAKEN), which _publish_then_probe must
  turn into the same refusal instead of letting the 409 leak.
---
# A mailbox on someone else's agent is refused as FOREIGN_TARGET

> Ground truth. Proven by the fix 476a919eb (PR #814, 2026-11-10): the bound test failed without it and passes with it. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.foreign_agent_mailbox.rules
sites:
  - rel_path: "tests/hub_tests/test_agent_email_foreign_agent.py"
    line: 91
    note: "FAILING? read this tag's rules before touching _publish_then_probe or confirm_hub_row_is_ours"
```

## Expected behavior

Alice saves a local Agent whose id is Bob's hub agent and calls `allocate_mailbox()`.
She gets `AgentMailboxError` with `code == FOREIGN_TARGET` and `status_code == 403`
("this agent already exists on the hub under another account …"), and
`agent.remote` stays `False`.

## Internals

* `Agent.allocate_mailbox()` (`flow_sdk/builtin/agent.py:1014`) calls
  `AgentMailbox.allocate()` (`flow_sdk/builtin/agent_mailbox.py:450`). The first
  `get_mailbox` probe answers `TARGET_NOT_FOUND`, which the app reads as either "no such
  agent" or "not yours". For an unpublished agent it goes to `_publish_then_probe()`
  (`agent_mailbox.py:540`).
* `_publish_then_probe()` calls `agent.share()`. `Entity.share()`
  (`flow_sdk/core/entity/entity_model.py:2299`) POSTs the row. On a 409
  (`entity_model.py:2369`) it calls `confirm_hub_row_is_ours()` (`entity_model.py:2391`),
  which GETs the row and, when that answers target-missing, raises
  `HubError(409, code=HubErrorCode.ID_TAKEN)` (`flow_sdk/cloud_client/shared/errors.py:29`).
* `HubError` derives from `Exception`, so the `contextlib.suppress(ValueError, RuntimeError)`
  around `share()` does not catch it. **The fix** (`agent_mailbox.py:585`) catches
  `HubError` with `code == ID_TAKEN`, sets `agent.remote = False`, and raises the same
  `FOREIGN_TARGET` error the post-publish probe raises (`agent_mailbox.py:602`).
  Any other `HubError` is re-raised unchanged.

## Invariants

* Both ways of learning "someone else's agent" (an `ID_TAKEN` from `share()`, or a
  probe that still says `TARGET_NOT_FOUND` after publishing) raise the one `foreign`
  error: 403, `FOREIGN_TARGET`, the same sentence.
* A refused allocation never leaves `agent.remote` True.
* Only `ID_TAKEN` or a masked `TARGET_NOT_FOUND` counts as "foreign". Offline, signed-out
  or 5xx failures pass through as themselves, because calling an outage "not yours"
  would be a false diagnosis.

## Failure modes

* **Before the fix:** after `share()` started raising the typed `HubError(ID_TAKEN)`, it
  escaped `_publish_then_probe` as a raw 409, and the test's
  `pytest.raises(AgentMailboxError)` failed.
* Narrowing the `except HubError` to a status code instead of `HubErrorCode.ID_TAKEN`, or
  catching every `HubError`, either leaks the 409 again or reports outages as
  foreign agents.
* The sibling premise tests in the same file (`test_the_hub_masks_…`,
  `test_publishing_someone_elses_agent_really_conflicts`) pin the hub's answers that this
  logic relies on. If they fail, the hub changed, not this code.
