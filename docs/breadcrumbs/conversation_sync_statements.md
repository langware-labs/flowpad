---
id: edf12d4a-d2c9-40a3-923e-2b31e4e5f5f3
title: A first conversation sync is paid in SQL statements per created row
tags:
- breadcrumb.test.conversation_sync_statements.rules
description: The 2,400-conversation sync benchmark failed on loaded CI runners at 12-17 s (3-4 s
  locally). Each created row issued five statements, and each is several round trips between the
  event loop and the SQLite thread; two were redundant for a row mirror_batch proved absent.
---
# A first conversation sync is paid in SQL statements per created row

> Ground truth. Proven by RCA on 2026-11-09. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.conversation_sync_statements.rules
sites:
  - rel_path: "tests/unit/hub_proxy/test_conversation_sync_benchmark.py"
    line: 71
    note: "FAILING? never raise the 12 s cap - read this tag's rules first; the cost is SQL statements per created row, not the logic"
  - rel_path: "tests/unit/test_save_is_one_write.py"
    line: 111
    note: "FAILING? a row mirror_batch proved absent must be created without an existence read or an FTS delete - read this tag's rules"
```

## Expected behavior

A first sync of 2,400 hub conversations (`handle_conversation_list`) answers within its foreground
budget and finishes the rest in the background, under 12 s in all, on a loaded CI runner too.
Locally it takes ~3.2 s with nothing left for the background.

## Internals

| step | where |
| --- | --- |
| Foreground budget, then the rest in one background task | `FOREGROUND_RECONCILE_S` (`flow_sdk/app/actions/flow_message_action.py:4154`), `_dispatch_deferred_reconcile` (`:4160`) |
| Rows mirrored 50 at a time in one writer transaction | `RECONCILE_BATCH` (`:4156`), `Conversation.mirror_batch(ids)` (`:4040`) |
| The batch reads its ids once, under the writer lock; the absent ones go into `_VERIFIED_ABSENT` | `Entity.mirror_batch` (`flow_sdk/core/entity/entity_model.py:2703`) |
| A create of such an id is marked proven new for its write | `_as_proven_new` (`entity_model.py:139`), applied at `:3033` |
| The marker | `PROVEN_NEW_ROW` (`flow_sdk/db/drivers/db_driver.py:26`) |
| The driver skips the existence read, and the FTS delete | `SQLiteDBDriver.save` (`flow_sdk/db/drivers/sqlite/sqlite_driver.py:1469`), `fts_upsert` (`:784`) |

A created row now issues three statements: INSERT entities, INSERT FTS, INSERT relationship (owner).

## Invariants

* **Never raise the 12 s cap.** A failure means the per-row cost grew. Count the statements a
  created row issues before looking anywhere else.
* **Each statement is the cost.** Through aiosqlite every statement is several round trips between
  the event loop and the SQLite thread (~36 loop cycles a row at five statements). On a busy runner
  each round trip is far slower than locally, so a local pass proves little.
* **Only a row `mirror_batch` read as absent, under the writer lock, skips the reads.** No other
  connection can create it before the batch commits. The id is consumed on first use: a second save
  of it in the same batch reads and updates.
* **A wrong skip fails loudly.** If the row existed anyway, the INSERT hits the primary key, the
  batch fails, and `reconcile_rows` replays it row by row through the ordinary save.

## Failure modes

* **The benchmark fails on CI and passes locally.** Expected when a change adds a statement per
  created row. Measure statements per row with a `before_cursor_execute` listener around
  `_upsert_hub_conversation_metadata`, and event-loop cycles with cProfile (`select.kqueue`
  `control` calls).
* **Ruled out on 2026-11-09:** the shard's file order (it passes locally in exactly shard 4/4's
  order), and competition from `stream_inbox.recompute_unread` (removing it changed nothing).
* **Tried and dropped:** one multi-row FTS INSERT per batch. It gained ~0.5 s under load, and an
  update or delete inside the batch would have needed handling.
* **What is left per row** is Python work spread across pydantic validation and serialization, with
  no single hotspot.
