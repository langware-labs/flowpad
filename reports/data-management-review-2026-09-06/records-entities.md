# Records / entities / persistence review

Reviewed current implementation and docs on 2026-09-06, final anchor check at HEAD `14635091fdd671558cb209b99a84409aaf3788b5`. The six named core files below were clean at that check. The checkout can change concurrently; findings concern the inspected implementation, without attributing changes to a particular author. Read `docs/CLAUDE.md`, `record-model.md`, `database.md`, `entity-index-sync.md`, `invalidation.md`, and the slick skill. No product files, running instances, or instance databases were modified. The executable probe is `/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/evidence/flowpad_record_review_probe.py`; it imports the existing test isolation bootstrap, then uses a temporary records root and SQLite database. All its writes are disposable. No timeouts/retry budgets were altered.

## Confirmed findings

### RE1 — P1: GET refresh acknowledges source changes without indexing them

**Confidence: confirmed with real SQLite + source files.**

`Entity.check_and_refresh_record` ([flow_sdk/core/entity/entity_model.py:1518](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/core/entity/entity_model.py:1518)) calls `get_record` (`:1265`), which loads `metadata.json`. When the source fingerprint changed, it calls `record.sync_to_db()` and then `record.write_hash()` (`:1533–1538`). `FSRecord._sync_to_db_unlocked` (`flow_sdk/fs_store/fs_record.py:981–989`) builds the row from this same shadow object and never invokes the source parser. The shadow also carries the previous `updated_date`, so `Entity.from_record` (`entity_model.py:1063`) does not derive a new source mtime.

**Reproduction:** index a Markdown document titled `Before`, edit its authoritative frontmatter to `Afterward` and body to a new token, advance mtime with `os.utime`, and call `check_and_refresh_record`. Before: `index_required=True`. After: method returns `True`, `index_required=False`, but DB title is `Before`, FTS still contains the old body, and `updated_date` is unchanged. A fresh `TypeInfo.record_for` immediately reads `Afterward`.

The GET path therefore marks stale data current until a force-parse trigger runs; field-backed views and body reload tokens can both stay stale.

**Smallest fix seam:** unify freshness refresh with the existing fresh-parse path (`discover_record_by_path`/the type parser), preserving record identity and holding the existing record guard. Stamp the sentinel only for the successfully parsed/committed source snapshot. Preserve a separate shadow-only path for records with no authoritative asset.

**Verification:** actual source edit followed only by entity GET/refresh must update metadata fields, FTS, and reload token, then clear staleness. Existing `test_record_refresh_serialization.py` exercises project freshness and lock ordering, but not a source-body change.

### RE2 — P1: nullable updates are not durable; ungrouping reverses on reindex

**Confidence: confirmed with real Group rows and shadows, no mocks.**

`Entity.metadata_payload` uses `exclude_none=True` (`entity_model.py:1347`), and `FSRecord.save_metadata` skips `None` while preserving all old keys (`fs_record.py:546–558`). This deliberately protects partial writes but cannot represent an intentional clear. The existing `remove_metadata_keys` API is not used by generic nullable field updates.

The user-facing `set-group` action (`entity_model.py:3515–3523`) and `Group.move` (`flow_sdk/builtin/group.py:116–125`) set `group_id=None` and save; `delete-group` promotes children to a possibly null parent (`group.py:135–138`).

**Reproduction:** save a Group whose `group_id` is another group's ID; assign `None`, save; read DB/shadow; run `shadow.sync_to_db()`. DB initially shows null, shadow still holds the old parent, and the reindexed DB restores the old parent ID. The same persistence mechanism affects other nullable persisted fields, although those were not individually reproduced.

**Smallest fix seam:** distinguish omitted fields from explicit clears at the shared DB→shadow boundary. Track owned/changed persisted fields and provide an explicit delete-key/tombstone operation; retain no-clobber behavior for genuinely omitted fields. Merely changing global None handling would violate the intended stale-writer safeguard.

**Verification:** generic ungroup/move-to-root/delete-group promotion remains ungrouped after reload and reindex; unrelated omitted fields remain preserved.

### RE3 — P1: successful fs-records PUT never updates the authoritative asset

**Confidence: confirmed through the real action handler.**

`FsRecordsActionsMixin._fs_records_action` PUT (`flow_sdk/builtin/faas/fs_records_actions.py:2410–2422`) calls `RecordList.update` (`flow_sdk/fs_store/record_list.py:56–62`), which writes the shadow only; `_index_sync_warning` (`fs_records_actions.py:2158–2170`) adopts it into DB. `Entity.from_record` explicitly suppresses `Entity.store` (`entity_model.py:1139–1148`). The route then broadcasts success without invoking the asset serializer. POST has a separate materialization step (`fs_records_actions.py:2378–2385`); PUT has no corresponding authoritative write.

**Reproduction:** source document title `Afterward`; real PUT handler receives `{title: "APIUpdated", body: "apiupdateduniquetoken"}`. It returns `SUCCESS` and DB title becomes `APIUpdated`, but source bytes remain identical. A normal fresh parse + sync restores DB title `Afterward`, losing the acknowledged change. The only stub supplies the request object; the handler, DB, record update, parser, and broadcasts run unchanged.

**Smallest fix seam:** funnel this mutation through the same typed Entity/DataSerializer authoritative write used by ordinary updates, then rebuild the projections. An explicit shadow-only administrative API should be separate if genuinely required. This also removes duplicate CRUD persistence logic and its second broadcast.

**Verification:** edit asset fields via this route, confirm source bytes contain them, then force reindex and confirm fields remain. Include both file and folder assets.

### RE4 — P1: observers are notified before the transaction commits, including rolled-back creates

**Confidence: confirmed fault injection after the row write.**

`FSRecord._sync_to_db_unlocked` opens one outer session (`fs_record.py:981`) and calls `Entity.from_record(... notify=True)` before FTS/wiki work. `DBEntity.save` emits notifications as soon as the nested driver save returns (`flow_sdk/db/db_entity.py:438–453`), but nested `_session_ctx` merely yields the ambient session (`sqlite_driver.py:1305–1308`); the commit is at the outer exit (`:1338–1339`). `add_entity_op_notification` publishes the tag and schedules WebSocket delivery immediately (`db_entity.py:464–473`, `resource_tracker.py:220`). `DBEntity.delete` even sends DELETE before calling the database delete (`db_entity.py:479–485`).

**Reproduction:** subscribe to `entity.created`, run a real Markdown `sync_to_db`, inject an exception in the subsequent FTS upsert. Result: create event emitted `True`, entity row present after rollback `False`, shadow still exists. This is a bounded fault-injection result, not a claim that FTS fails routinely.

Observers can receive a row that never committed, refresh against the old snapshot, or trigger workflows for a rolled-back write. File writes also occur before DB commit inside this pipeline, so the broader durability semantics need to be explicit.

**Smallest fix seam:** let the canonical transaction scope queue immutable entity events and publish only after successful commit; discard on rollback. Place DELETE publication after successful deletion. An after-commit queue avoids duplicating sequencing policy in every caller; use a durable outbox only if delivery-across-crash guarantees are required.

**Verification:** rollback emits no committed-change event; post-commit observers on a separate session see the new row and associated FTS state. Cover deletion failure and batched index transactions.

### RE5 — P1/P2: ambient AsyncSession leaks across child tasks

**Confidence: exact session sharing reproduced; downstream concurrency failures are risk inferred from the confirmed ownership defect.**

`_standalone_session_var` stores only the session (`sqlite_driver.py:62`); `_session_ctx` checks neither creating task nor driver before reusing it (`:1305–1308`). Its documentation promises reuse only in the same task. `asyncio` child tasks inherit ContextVars, so the promise is not implemented. The record lock already solves this correctly by including task identity (`fs_record.py:217–229`).

**Reproduction:** inside a real driver `_session_ctx`, spawn `asyncio.create_task` and enter `_session_ctx` in the child: `child_session is parent_session` is `True`.

This is reachable in ordinary sync work: `sync_to_db → DBEntity.save → emit_entity_tag → TagEventBus._dispatch`, whose async consumers run via `asyncio.ensure_future` (`flow_sdk/tags/bus.py:253–263`). For example, GraphWorkflowManager subscribes an async DB-loading `_rearm` handler to `entity.updated` (`flow_sdk/graph_workflow_manager/manager.py:441–455`). Such work can overlap a parent transaction or outlive its scope, despite having independent lifecycle expectations.

**Smallest fix seam:** bind `(driver, owning task, session)` and reuse only for that owner; apply equivalent ownership checks to any request-bound session. Keep nested calls in the same task unified. After-commit notification fixes RE4 and reduces one major source of inherited sessions, but ownership should still be enforced generically.

**Verification:** same-task nested calls reuse; child tasks and other drivers do not; an async subscriber after scope exit gets a fresh managed session. Do not address resulting contention by increasing waits.

## Optimization and code reduction opportunities

### RE6 — High-value measured storage reduction: duplicate Markdown body in every shadow

`spec_extractor` dumps all fields including `body`, then adds a concatenated `content` string (`flow_sdk/fs_store/serializer/record.py:57–65`). For Markdown with no links, `body` and `content` are the same text. `FSRecord.save` persists both in indented JSON (`fs_record.py:518–524`), and FTS stores another content copy. `Markdown.body` correctly avoids the Entity JSON column (`flow_sdk/builtin/claude_memory_entities.py:95–97`); preserve that choice.

**Measured synthetic example:** 1,000,000-character body; source file 1,000,051 bytes after identity stamping; shadow 2,000,937 bytes; body length 1,000,000 and content length 1,000,000. This is a storage-size measurement, not a production timing benchmark. Removing the duplicate content alone saves about half this shadow, and about a quarter of the roughly four uncompressed body copies across source + shadow body + shadow content + FTS content (excluding FTS token structures).

**Seam:** make search content a derived TypeInfo projection of one canonical body rather than another persisted shadow field. After RE1 is fixed, consider making full source bodies transient in shadows and retaining only metadata/freshness; validate every shadow consumer first. A single snapshot parse should supply entity metadata, FTS, and wiki extraction. Physical compression is less valuable than removing duplicate representations and their update paths.

### RE7 — High-value query/code reduction: RecordList pagination reads the whole type from disk

The generic GET route (`fs_records_actions.py:2348–2357`) invokes `RecordList.query`, which calls `_discover()` before any filter (`record_list.py:76–82`); `FSRecord.discover` materializes every shadow (`fs_record.py:653–678`). `RecordQuery.apply` filters and sorts the complete list, then slices (`flow_sdk/fs_store/record_query.py:117–139`). Requesting a small page therefore reads/parses O(N) metadata files, potentially including the duplicate body payload above.

This duplicates the existing Entity/SQLite filter, sort, and pagination system and contradicts `entity-index-sync.md:44–57`, which places collection queries in SQLite.

**Seam:** translate supported record-list filters to the existing DB query layer, select IDs first, and hydrate only the page when full record metadata is requested. Keep filesystem enumeration explicitly for unindexed/recovery use. This offers both runtime savings and deletion of a parallel query/CRUD path. There is no production benchmark here; the O(N) file-read behavior is structural. Validate with counted shadow reads for a fixed-size page while N grows.

### RE8 — Smaller code reduction: converge record-to-entity normalization

`Entity.from_record` and `_build_from_fs_record` (`entity_model.py:963`, `:1208`) independently flatten metadata and construct typed entities, with different precedence rules: async lifting fills missing top-level keys only (`:986–991`), DB-free loading lets all nested metadata override top-level values (`:1220–1225`). Both broadly fall back to base Entity on construction error. The async path still contains legacy `PropertyRecord`, `_property_types`, and `get_prop` branches (`:1013–1032`, `:1130–1138`) despite the single concrete FSRecord contract.

Extract one pure `record → validated typed fields` function with explicit precedence and error results; use it for DB-free and DB-backed paths. Remove legacy branches only after checking callers. This is an architectural opportunity and divergent semantics, not a separately reproduced user bug. Avoid estimating a large LOC saving without implementing it.

## Robustness and documentation contract gaps

- **The DB is not globally disposable.** [docs/CLAUDE.md:7](/Users/shlom/Documents/dev/flowpad-oss/docs/CLAUDE.md:7) says the entire DB can be deleted and rebuilt without data loss, but `Entity.save` intentionally skips shadows for `db_only` types (`entity_model.py:2492–2501`). Current explicit types include SourceItem (`source_item_type_info.py:25`), DataSourceCursor/ConsumerPosition/SourceChange (`data_source_type_info.py:53–73`), and Tab (`tab_type_info.py:10`). Cursor opaque state/high-water and enabled state are meaningful recovery inputs, not source-file projections. Keep high-churn operational records in DB if appropriate, but document durability tiers and ensure backup/rebuild actions preserve authoritative rows. This is a confirmed contract contradiction; this review did not delete a real database or prove that a particular rebuild endpoint loses these rows.
- **Shadow writes are not crash-atomic.** `FSRecord.save`, `save_metadata`, and `remove_metadata_keys` directly `write_text` to the destination (`fs_record.py:521`, `:560`, `:594`). Truncation/interruption can leave invalid JSON; discovery silently skips malformed entries (`:677–680`). A shared same-directory temp-and-replace writer is the small robustness seam. This is a source-inspected crash window, not a reproduced power-loss failure. The DB→disk `_store` also catches persistence errors and returns None (`entity_model.py:1413–1417`), while Entity.save returns success; for shadow-authoritative types, explicit failure/repair state should be surfaced.
- **Docs describe a different refresh contract.** `invalidation.md` says sync_to_db re-parses from disk in its loop table, but later correctly warns that loaded shadows contain stale body/content and mandates force-parsing. RE1 is exactly the contradiction. It also says GET refresh errors are swallowed silently; current code logs a warning (`entity_model.py:1539–1546`).
- **Docs describe a different shadow write contract.** [docs/CLAUDE.md:25](/Users/shlom/Documents/dev/flowpad-oss/docs/CLAUDE.md:25) names save_metadata as the single DB→shadow writer, but `sync_from_entity` calls full `save()` (`fs_record.py:1043–1046`). [docs/CLAUDE.md:35](/Users/shlom/Documents/dev/flowpad-oss/docs/CLAUDE.md:35) says main_ref aliases asset_ref, but current main_ref resolves a folder's inner primary body (`fs_record.py:475–486`). The current behavior can be sound; the architectural contract needs updating.
- **CRUD failure reporting improved beyond the docs.** `entity-index-sync.md` claims failed sync is only DEBUG logged with silent success. Current `_index_sync_warning` logs WARNING and returns structured response warnings (`fs_records_actions.py:2158–2188`). Preserve that improvement and update the text.

## Sound decisions to preserve

Single concrete FSRecord with TypeInfo-owned parsing/identity/layout; one UUID adoption seam and natural-key lookups; separate Entity and FTS projections; no DB column for Markdown body; per-record locks with task-aware reentrancy; structural suppression of source writeback during disk adoption; SQLite WAL readers separated from writer transactions; unified nested session/engine machinery; disk-first recovery for actual file-backed assets; DB-only storage for intentionally high-churn state where durability is declared. Fix the ownership and publication edges rather than replacing these useful seams with another general-purpose manager.

## Suggested order

1. Repair authoritative PUT writes, nullable clears, and stale GET refresh, with round-trip regressions.
2. Add transaction-owned event publication and task-owned sessions together.
3. Define storage authority/durability tiers; surface and atomically write failed shadow persistence.
4. Remove duplicate shadow content and route collection pagination through SQLite.
5. Unify normalization, trim unreachable legacy branches, and update contradictory docs.
