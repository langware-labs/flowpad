---
id: ad74a288-2b09-485f-8922-bc4d8aaf5b3f
---

# Doc comment — drawn in the shared doc, live on the other peer's page

A comment on a doc is drawn **in the doc**, under the passage it quotes, and a reply
from another peer appears on an open page **without a reload**.

## Setup

1. Alice and Bob: two instances logged in to the local hub (`:8093`). Bob's UI is
   running (`QA_BOB_UI`) and his project folder is `QA_BOB_PROJECT_DIR`
   (`QA_BOB_PROJECT_ID`) — the shared doc is written there so Bob's page can open it.
2. Alice creates the doc and shares a conversation that carries it; Bob accepts and
   indexes the doc (same entity id, from its frontmatter).

## Binding criterion

- Alice posts a `questions` comment on "Line 2". On Bob's page the card is drawn in
  the doc with the question's title, and the passage is highlighted.
- With Bob's page still open, Alice replies in the thread. **The reply appears on
  Bob's page without a reload.**

## Coverage

- **browser** — `ui/tests/manual_regression/collaboration/doc_comment_inline_live.md.ts`
- **pytest** — `tests/unit/test_upsert_from_hub_child_edge.py::test_new_child_is_announced_after_its_edge`
