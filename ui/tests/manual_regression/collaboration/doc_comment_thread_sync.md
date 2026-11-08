---
id: 8cf45979-5767-4212-bc2c-45ddf3eb0fcc
---

# Doc comment thread — questions, answers and replies cross peers (Alice ↔ Bob)

A doc comment is a thread: a root comment that carries typed data (an agent's
`questions` form, a `change_request`, a note) and replies. On a shared doc only a
comment's author may edit it, so everything after the root — a reply, the answers to
the questions, a status change — is a **new comment naming its root in `reply_to`**.

## Setup

1. Alice and Bob are two instances, each cloud-logged-in as its own hub user against
   the local hub (`:8093`), launched via `scripts/instance_ctl.sh`.
2. Alice shares a conversation with Bob; Bob accepts.

## Binding criterion

- **A→B:** Alice posts a `questions` comment (a form). Bob's instance receives it
  with its form intact.
- **B→A:** Bob answers it with a reply carrying `answers` and `status: sent`, and
  writes a text reply. Alice's instance receives both, each naming the root in
  `reply_to` — so Alice's thread reads Bob's answers and the new status.

## Coverage (cross-layer)

- **pytest** — `tests/hub_tests/test_doc_comment_child_sync.py::test_doc_comment_thread_sync` (doc-bound)
- **vitest** — `ui/tests/unit/doc-comments.test.ts` (thread assembly: status/answers/anchor from replies)
- **browser** — `ui/tests/manual_regression/collaboration/doc_comment_thread_sync.md.ts`
