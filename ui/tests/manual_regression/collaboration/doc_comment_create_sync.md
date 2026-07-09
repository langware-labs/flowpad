---
id: 987c8038-f50c-464d-b817-01985ac72d5c
---

# Doc comment create — live child sync (Alice ↔ Bob)

Comments are the concrete vehicle for the **generic "sync entity children live"**
mechanism: a `comment` child on a shared entity created on one instance must appear
on every other instance sharing that entity, in real time. Nothing here is
comment-specific — the same path carries any `shared_child` type.

## Setup

1. Alice and Bob are two separate instances, each cloud-logged-in as its own hub
   user against the local hub (`:8093`), launched via `scripts/instance_ctl.sh`.
2. Alice creates a conversation and shares it with Bob; Bob accepts. The
   conversation is the comment **parent** (the generic `is_child` path — no shared
   markdown doc, so the catch-up does no bundle/index work).

## Binding criterion

- **A→B:** Alice creates a comment on the shared conversation. Within real-time
  bounds, **Bob's instance receives it** (the comment, with its `raw_content` and
  `line`, is readable on Bob after a catch-up sync).
- **B→A:** Bob creates a comment. **Alice's instance receives it.**

The comment auto-shares to the hub on create (server-side `create_child`); the
receiver materializes it via the conversation catch-up sync.

## Coverage (cross-layer)

This scenario is implemented at all three layers, keyed by ScenarioId
`987c8038-f50c-464d-b817-01985ac72d5c`:

- **pytest** — `tests/hub_tests/test_doc_comment_child_sync.py::test_doc_comment_create_sync`
- **vitest** — `ui/tests/hub/doc_comment_sync.test.ts` ("create" case)
- **browser** — `ui/tests/manual_regression/collaboration/doc_comment_create_sync.md.ts`
