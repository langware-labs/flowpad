---
id: 4f1ae181-59af-5e0f-832d-55a419806ca7
---

# Content Invalidation (file change → reindex → refresh)

How a change to a file on disk becomes fresh content in the UI. This is the
generic **invalidation loop** that keeps an open asset editor in sync with its
backing file when the file is written **out-of-band** — by an agent turn, an
external editor, or any client pushing a changed-file set.

## The four-part loop

```
file change  →  entity re-index  →  entity change  →  refresh
  [edge 1]        [sync_to_db]       [updated_date +      [FE body
  trigger      re-parse from disk    data_op_msg]         re-read]
```

| Part | What happens | Owned by |
|------|--------------|----------|
| **1. file change** | a file is written on disk | any writer |
| **1→2 trigger** | something asks the record to re-index | GET-time refresh, `POST /fs-records/invalidate`, or the agentic turn-end seam |
| **2. re-index** | `FSRecord.sync_to_db()` re-parses the source from disk → Entity row + FTS + wiki | [Entity-Index Sync](entity-index-sync.md) |
| **2→3 stamp** | `Entity.from_record` stamps `updated_date` from the file mtime | `entity_model.py` |
| **3. entity change** | `sync_to_db(notify=True)` → `data_op_msg` broadcast to watchers | [Entity-Index Sync](entity-index-sync.md), [Listen Action](listen-action.md) |
| **3→4 deliver** | `DataManager.onDataOp` merges + `_notifyAllAliases` fires subscribers | `ts_sdk/src/FlowSync/store.ts` |
| **4. refresh** | field-backed editors re-render; **file-body** editors re-read the body | `useFSRefContent` |

The **middle** links (2, 2→3, 3, 3→4) are the general index-sync machinery —
see [Entity-Index Sync](entity-index-sync.md). This document focuses on the two
**outer edges** that make invalidation work for an out-of-band write: the
trigger (edge 1) and the file-body re-read (edge 4).

## Edge 1 — the trigger (what causes a re-index)

Re-indexing is **pull-based**, not a filesystem watcher. A record re-indexes
only when something calls it. There are three triggers:

### a. GET-time refresh (lazy, per-entity)

Every entity GET schedules a non-blocking freshness check:
`handle_get_by_id` → `asyncio.create_task(entity.check_and_refresh_record())`
(`flow_sdk/app/actions/graph_crud_actions.py:110`). Under `record_sync_guard`,
if `record.index_required` is true (source hash **or path digest** differs from
the `.hash` sentinel), it re-syncs and re-stamps; any error in the re-sync is
swallowed silently (`entity_model.py:1530`).
This covers navigation/open, but **not** a file that changed while already open —
nothing re-GETs it.

### b. `POST /fs-records/invalidate` (push, explicit)

The general push trigger. Any client sends the changed-file set and the backend
re-indexes + broadcasts:

```
POST /api/v1/graph/compute_node/@local/fs-records/invalidate
  { "paths": [ ...changed/created... ], "deleted_paths": [ ...removed... ] }
  → { reindexed, minted, orphaned, skipped, counts }
```

Handler `_handle_fs_records_invalidate` (`fs_records_actions.py:1945`) →
`reindex_paths(paths, deleted_paths=..., mint=True)` (`flow_sdk/fs_store/reindex.py:143`).
`mint=False` makes the call resolution-only (a path with no owning entity is
left alone) — the `fs/write` resync passes it, because minting there would
stamp an id into a file the user just wrote. Per changed path,
`reindex_paths`:

1. resolves the path to its owning entity via
   `Entity.get_by_asset_ref(path, resolve_containing=True)` — an inner file of a
   folder-backed asset (a file under a skill/task/deck folder) resolves to the
   **owning folder entity**, not a per-file entity;
2. **force re-parses from disk** via
   `resolve_asset(entity.asset_ref, type_name=entity.type, owner_id=entity.id)` + `index_one(notify=True)` (`fs_store/resolve.py`) — NOT
   `get_record()+sync_to_db()`: the shadow `metadata.json` holds a **stale**
   `body`/`content`, so only a fresh `from_disk_fn` parse reflects the new bytes.
   It re-parses the **entity's own** `asset_ref` (the folder path for folder
   types), never the raw inner path (which the extractor would mis-name);
3. mints a type-inferred entity for a brand-new file with no owner;
4. reconciles `deleted_paths` — orphans/removes a gone standalone entity, or
   re-syncs the still-present folder when only an inner file was removed.

`notify=True` makes the fresh-parse `sync_to_db` broadcast the `data_op_msg` for
free — no separate broadcast step.

### c. Agentic turn-end (push, automatic)

At the end of every agent turn, the files the turn wrote/edited are pushed
through `reindex_paths` so their editors refresh without the user doing anything.
Because the three transports detect turn-end differently, `AgenticProcess` fires
one helper — `_schedule_turn_end_reindex` — from **three** seams
(`flow_sdk/builtin/agentic_process/agentic_process.py`):

| Seam | Transport |
|------|-----------|
| `_flush_transcript_change` busy→not-busy edge (`_schedule_turn_end_reindex("flush")`) | PTY / TranscriptStreamer turns |
| `end_headless_turn` (`_schedule_turn_end_reindex("headless")`) | headless `driver.headless_prompt` (executeInstruction) |
| `_http_prompt` `_run_turn` `finally` → `end_headless_turn("prompt")` | the streaming SDK `worker.prompt()` path — shares the headless seam rather than calling the helper itself |

The touched-file set is read from the **watermarked transcript tail**
(`_collect_touched_from_transcript_tail` → `_iter_touched_paths`), so each turn
only re-indexes its own new `FileWrite`/`FileEdit` ops. The reindex is
fire-and-forget (`asyncio.create_task`) — it never blocks the turn.

> There is a filesystem watcher in the tree (`flow_sdk/server/fsop_watcher.py`,
> `watchfiles`), but it drives **user-configured FSOp triggers**, not
> index invalidation. Do not wire index refresh onto it.

## Edge 2→3 — `updated_date` is the change token

`Entity.from_record` derives `updated_date` from the source's real
last-modified time (not the index instant) via `_asset_updated_epoch`
(`flow_sdk/core/entity/entity_model.py`):

```
updated_date = max( getmtime(src_path),           # add/remove of children
                    asset_hash_fn(src_path) )      # deepest INNER-file mtime
```

The `max` is load-bearing for **folder-backed** assets: a directory's own mtime
does **not** move when a file *inside* it is content-edited (editing `SKILL.md`,
a deck layout, …). The registered `asset_hash_fn` already computes the deepest
inner-file mtime exactly to catch child-content edits (see `docs/CLAUDE.md`
rule 14), so folding it in makes **both** an added file and an edited inner file
advance the stamp. A sane-epoch bound guards against a future non-mtime
`asset_hash_fn` poisoning the timestamp.

For **remote** (hub-authoritative) rows `updated_date` is the LWW clock and is
NOT moved by a local re-index — the hub broadcasts its own clock. See the
`updated_date` double-booking note in the record-model history.

## Edge 4 — the frontend body re-read

`data_op_msg` reaches the frontend and `_notifyAllAliases` fires **on any field
change** — so an `updated_date`-only update re-renders subscribers. That is
enough for **field-backed** editors (task, workflow, …), which read their fields
straight off the cached entity.

**File-body** editors (markdown, skill, deck) read the body **separately** from a
file, so a re-render alone shows stale text. They close the loop with
`useFSRefContent`'s `reloadKey` (`ui/src/hooks/use-fs-ref-content.ts`):

- `reloadKey` is fed the resolved entity's `updated_date`, coerced to a stable
  scalar by `entityReloadKey` (`ui/src/utils/entity-reload-key.ts`);
- when it changes, the load effect re-reads the body from disk;
- **guarded against unsaved edits** — a `reloadKey` change is ignored while the
  buffer is dirty, so an external write never clobbers the user's in-progress
  edits (their save wins). A path change or explicit `reload()` still reloads
  regardless.

The token is threaded through the editor wrappers:
`PlainMarkdownAssetEditor` / `SkillAssetEditor` / `DeckTemplateViewer` →
`useMarkdownContent` / `useSkillContent` → `useFSRefContent`.

## Gotchas

- **Pull, not push.** Nothing re-indexes an open file on a bare disk write —
  a trigger (edge 1) must fire. For out-of-band edits, use `/fs-records/invalidate`
  or the agentic turn-end seam.
- **Freshness token is mtime+size** (plus inner-file mtimes for folder types),
  plus a digest of the asset path so a relocated file re-indexes. A same-mtime,
  same-size content edit at the same path evades `index_required` on the
  GET-time path — but the explicit `/invalidate` and turn-end paths force a
  re-parse regardless of the sentinel, so they still refresh.
- **Force re-parse, not `sync_to_db` on a loaded record.** The shadow metadata
  body is stale; always route a forced re-index through
  `resolve_asset` + `index_one(..., notify=True)`.
- **Dirty-guard drops external changes while editing** — intentional. The user's
  save wins; don't remove the guard to "always refresh".

## Key files

| File | Role |
|------|------|
| `flow_sdk/fs_store/reindex.py` | `reindex_paths()` — resolve → force re-parse → broadcast; mint/orphan |
| `flow_sdk/builtin/faas/fs_records_actions.py` | `_handle_fs_records_invalidate` (route) |
| `flow_sdk/fs_store/resolve.py` | `resolve_asset` + `index_one` — the one-path resolve the route composes |
| `flow_sdk/builtin/agentic_process/agentic_process.py` | `_schedule_turn_end_reindex`, `_collect_touched_from_transcript_tail`, `_iter_touched_paths`, the three turn-end seams |
| `flow_sdk/core/entity/entity_model.py` | `_asset_updated_epoch`, `from_record` `updated_date` stamp, `check_and_refresh_record` |
| `flow_sdk/app/actions/graph_crud_actions.py` | `handle_get_by_id` → GET-time refresh |
| `ui/src/hooks/use-fs-ref-content.ts` | `reloadKey` body re-read + dirty guard |
| `ui/src/utils/entity-reload-key.ts` | `entityReloadKey` — `updated_date` → stable scalar |
| `ui/src/components/assets/editor/**` | markdown / skill / deck editors thread `reloadKey` |

See also: [Entity-Index Sync](entity-index-sync.md) (the `sync_to_db` pipeline +
`DataOpMessage`), [Listen Action](listen-action.md) (WS delivery →
`onDataOp` → React), [Scan and Discovery](scan-and-discovery.md) (bulk indexer
triggers), [Record Model](record-model.md) (`index_required`, hash sentinel).
