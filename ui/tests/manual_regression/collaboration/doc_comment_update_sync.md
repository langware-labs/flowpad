---
id: a43f4285-07ed-4f06-b299-071da5081e5e
---

# Doc comment update — live child sync (Alice ↔ Bob)

Editing a shared `comment` child on one instance must propagate the new text to
every other instance sharing its parent — the update arm of the generic
"sync entity children live" mechanism.

## Setup

1. Alice and Bob are two cloud-logged-in instances on the local hub (`:8093`),
   launched via `scripts/instance_ctl.sh`.
2. Alice shares a conversation with Bob; Bob accepts. Comments are children of
   that conversation.

## Binding criterion

- **A→B:** Alice creates a comment (`u1`); Bob receives it; Alice edits its
  `raw_content` to `edited-by-alice`; within real-time bounds **Bob's instance
  reflects the new text**.
- **B→A:** Bob creates a comment (`u1`); Alice receives it; Bob edits it to
  `edited-by-bob`; **Alice's instance reflects the new text**.

The edit reflects to the hub via `Hub-Reflect` on a remote save (the
`use-doc-comments` `updateComment` path); the receiver pulls the new body via the
conversation catch-up sync.

## Coverage (cross-layer)

ScenarioId `a43f4285-07ed-4f06-b299-071da5081e5e`:

- **pytest** — `tests/hub_tests/test_doc_comment_child_sync.py::test_doc_comment_update_sync`
- **vitest** — `ui/tests/hub/doc_comment_sync.test.ts` ("update" case)
- **browser** — `ui/tests/manual_regression/collaboration/doc_comment_update_sync.md.ts`

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
