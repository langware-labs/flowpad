---
title: A help desk guest gets a masked roster, never a 403
tags: [breadcrumb.test.helpdesk_masked_roster.rules]
description: A ticket guest reads its own row + one desk-brand row; members/<other> is []; the staff queue stays 401/403; no staffer id, email or name ever reaches the guest.
---
# A help desk guest gets a masked roster, never a 403

> Ground truth. Proven by RCA on 2026-11-11 (QA cycle qa-20261109-230009, i21). Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.helpdesk_masked_roster.rules
sites:
  - rel_path: "ui/tests/hub/helpdesk_two_client.test.ts"
    line: 149
    note: "FAILING? read this tag's rules before editing \u2014 a guest's masked roster is the contract, not a 403"
```

## Expected behavior
- A ticket guest (the requester) is a conversation member, so `GET /graph/conversation/<id>/list_members` answers **200**:
  exactly their own row, plus **one** row named `HELPDESK_DISPLAY_NAME` ("Flowpad Support") with no `user_id`, `id` or `user_email`.
- `GET .../members/<own id>` → 200 with their membership; `GET .../members/<anyone else>` → 200 with `data: []`.
- `GET /graph/project/<desk>/helpdesk_conversations` (the staff queue) → 401/403 for the guest.
- The staffer's hub id, email and name never appear in any of those bodies, before or after the staffer picks up and replies.

## Internals
- Hub (`langware-labs/flowpad-hub`) commit **d798de9bf** (2026-11-08), `flowpad/hub/app/actions/membership/services.py`:
  `_roster_context` returns the conversation's `roster_mask` instead of raising 403; `get_memberships_list` applies
  `_masked_roster(members, caller_id, mask)`; `get_membership` returns `[]` for another user under a mask.
  Why: the old 403 ("This conversation roster is private") made the desktop show a false "Cloud access denied" on every ticket.
- Hub unit test: `flowpad/hub/tests/unit/test_masked_roster.py`.
- The test helper `expectMaskedRoster` in `ui/tests/hub/helpdesk_two_client.test.ts` asserts all of the above, and the staff test calls it again after the reply.

## Invariants
- Masking, not refusal: a member always gets its roster.
- One desk row for all staff: the guest can never turn a wire `sender_id` into a person.

## Failure modes
- `expected [401,403] to include 200` at the members check: a test written before d798de9bf. The test is stale, not the hub.
- "list_members leaks the staffer": the mask is off or broken on the hub. That is a real exposure; never loosen the test for it.
  (Lever used: with `_masked_roster`/the `get_membership` mask disabled, the staff test fails on the staffer's id in list_members.)
- 401 "Invalid session token" right after a hub restart: hub sessions are in memory; relaunch the instances.
