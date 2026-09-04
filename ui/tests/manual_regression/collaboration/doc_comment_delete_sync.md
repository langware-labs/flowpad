---
id: 7dbcead1-46c8-434c-96d2-eac23050729f
version: 2
---

# Doc comment delete — live child sync (Alice ↔ Bob)

Deleting a shared `comment` child on one instance must remove it from every other
instance sharing its parent — the delete arm of the generic "sync entity children
live" mechanism. Delete propagates symmetrically with create: the server
auto-propagates `child_deleted` (no `Hub-Reflect` needed), mirroring create's
server-side auto-share.

## Setup

1. Alice and Bob are two cloud-logged-in instances on the local hub (`:8093`),
   launched via `scripts/instance_ctl.sh`.
2. Alice shares a conversation with Bob; Bob accepts. Comments are children of
   that conversation.

## Binding criterion

Every delete is first validated as **present on BOTH sides**, then removed for the
peer:

* **A→B:** Alice creates a comment; it is confirmed present on Alice **and** Bob;
  Alice deletes it; within real-time bounds **the comment disappears for Bob**.

* **B→A:** Bob creates a comment; confirmed present on Bob **and** Alice; Bob
  deletes it; **the comment disappears for Alice**.

## Coverage (cross-layer)

ScenarioId `7dbcead1-46c8-434c-96d2-eac23050729f`:

* **pytest** — `tests/hub_tests/test_doc_comment_child_sync.py::test_doc_comment_delete_sync`

* **vitest** — `ui/tests/hub/doc_comment_sync.test.ts` ("delete" case)

* **browser** — `ui/tests/manual_regression/collaboration/doc_comment_delete_sync.md.ts`

> **⚠ CONFLICT FOUND 2026-09-04 (Phase 11 QA).** The hub refuses this direction today.
> `flowpad/hub/app/policies.json` puts comment `update`/`delete` at **editor** level; a share
> recipient is granted **member** (→ `reader`), so a recipient may CREATE a comment but not edit
> or delete it — the hub answers `401 no valid access for role ['member'], action: update`.
> The policy comment records that this was deliberate, to stop a mere reader editing/deleting
> other people's comments; it also notes author-scoped editing is "not expressible here".
>
> This spec and that policy are in direct conflict, and it shipped unnoticed because this
> scenario infra-skips without the two-instance rig and had never actually run. Resolving it is
> a decision about the sharing model (grant recipients `editor`, or add author-scoping), not a
> test fix — so the test is left RED rather than rewritten to assert the refusal.
