# Index and search review

Scope: current working tree in `/Users/shlom/Documents/dev/flowpad-oss`, 2026-09-06. Read-only review using the `slick` placement/reuse lens. Read `record-search.md`, `entity-index-sync.md`, `transcript-indexing.md`, `llm-index.md`, `database.md`, and their implementation. No repository code edits, live instance writes, network changes, or timeout increases. Reproduction programs wrote only temporary SQLite databases/files.

## 1. P1 — Search applies limits before visibility filters, and the duplicated FaaS path ignores text-search offsets

**Confidence: reproduced with real route methods and real SQLite driver.**

Anchors:

- [flow_sdk/server/routes/search.py:259](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/server/routes/search.py:259): fetches only `limit + offset` from FTS.
- [flow_sdk/server/routes/search.py:275](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/server/routes/search.py:275): scope/folder/containment/system/tag filters run after that limit; `total` at line 281 counts only this truncated subset.
- [flow_sdk/builtin/faas/fs_records_actions.py:590](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/builtin/faas/fs_records_actions.py:590): ordinary browse fetches a SQL page before applying the visibility filters at lines 596–604.
- [flow_sdk/builtin/faas/fs_records_actions.py:629](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/builtin/faas/fs_records_actions.py:629): text search passes `limit` but never `offset` or `status` to `Entity.search`; status is then post-filtered. The parsed offset at line 495 is unused in this branch.
- [flow_sdk/server/routes/search.py:222](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/server/routes/search.py:222): the alternate REST browse implementation fetches all rows of the type, hydrates them, filters in Python, then slices at line 231.
- [flow_sdk/db/drivers/sqlite/sqlite_driver.py:874](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/db/drivers/sqlite/sqlite_driver.py:874) / `Entity.browse_page` at `entity_model.py:657`: a lower-layer paged query plus count already exists, including scope/system pushdown, but only the recent-activity FaaS branch uses it.

**Trigger / observed consequence:** six entities with identical searchable text; the highest-ranked four are project-scoped and closed, the remaining two user-scoped and active. With limit=2:

| Real handler request | Observed result | Expected |
|---|---|---|
| FaaS `q=needle&offset=0` | IDs 0,1; total=2 | First page; total=6 |
| FaaS `q=needle&offset=2` | IDs 0,1 again; total=2 | Different second page |
| FaaS `q=needle&status=active` | Empty; total=0 | Two active matches |
| REST `q=needle&user=true` | Empty; total=0 | Two user-scope matches |
| REST `q=needle` | Two matches; total=2 | total=6 |
| FaaS browse, limit=2 | Two rows; total=2 | total=6 |

This produces convincing false absence, repeated pages, and incorrect pagination termination. Increasing overfetch cannot make arbitrary filtering/counts correct. The two paths also parse calibration differently, normalize text differently, and return different fields, so sharing only post-filter helpers has not prevented drift.

**Smallest owning seam:** one typed backend search/browse service called by both route adapters. Push all matching predicates, deterministic ordering, offset, limit, and pre-page count into a driver query. Extend the existing `browse_page` projection rather than maintaining a second all-row browse path. Keep response adapters only where wire compatibility requires them. This removes two parallel orchestration implementations (219-line REST handler and 158-line FaaS handler; these are current source spans, not claimed net deletions) and makes one parameterized query test cover both entry points.

**Verification:** `/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/evidence/flowpad-review-search-routes.py`; `uv run python /Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/evidence/flowpad-review-search-routes.py`. The program uses an isolated temporary SQLite DB, real `search_records`, real `FsRecordsActionsMixin._handle_fs_records_search`, and real driver calls. Only the process-local driver singleton is redirected; source files and live instance data are untouched.

## 2. P1 — Freshness records source changes but cannot detect a deleted or incompatible secondary index

**Confidence: reproduced migration + real freshness predicate; skip behavior follows directly from the current indexer branch.**

Anchors:

- [flow_sdk/db/drivers/sqlite/sqlite_driver.py:454](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/db/drivers/sqlite/sqlite_driver.py:454): an older four-column FTS table is dropped and recreated, explicitly leaving its rows empty.
- [flow_sdk/fs_store/fs_record.py:699](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/fs_store/fs_record.py:699): freshness hash includes source metadata/fingerprint only.
- [flow_sdk/fs_store/fs_record.py:791](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/fs_store/fs_record.py:791): `index_required` checks source hash and path digest, with no producer/schema/index generation.
- [flow_sdk/fs_store/indexer/index_function.py:844](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/fs_store/indexer/index_function.py:844): skip-fresh additionally checks that the Entity row exists; it does not check FTS completeness or generation.
- [flow_sdk/fs_store/schema_registry.py:648](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/fs_store/schema_registry.py:648): `schema_hash` is advertised but does not participate in freshness; it also omits parser/extractor revision and `fts_content`.

**Concrete scenario:** an indexed asset has a current hash sentinel and an Entity row. Startup migrates the old FTS DDL. The Entity row and sentinel survive, but every FTS entry is removed. A normal, non-force index pass then skips the unchanged asset because both its sentinel and Entity row are current. The comment promising reindex on the next `POST /fs-records/index` is therefore false for this state; recovery requires force/rebuild or a source edit.

**Observed isolated output:** `rows_after_migration=1`, `fts_after_migration=0`, `index_required=False`, and the production normal-index freshness expression evaluates `True` (skip). The same design cannot automatically re-run changed extraction logic after a release when the source bytes/path stay unchanged.

**Smallest owning seam:** add a durable index generation and explicit producer revision to the index completion token. A destructive FTS migration increments the generation, so normal indexing repopulates unchanged sources without deleting Entity identities. The producer revision should cover actual extraction/FTS behavior; using the existing UI-oriented `schema_hash` alone is insufficient. Stamp completion only after all required projections for that generation commit. Test an unchanged source through migration and a non-force reindex.

**Verification:** `/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/evidence/flowpad-review-generation.py`; `uv run python /Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/evidence/flowpad-review-generation.py`. Creates old FTS DDL in a temporary DB, reopens the real driver to run its migration, and checks an actual `FSRecord` sentinel in an isolated shadow folder. This does not run a full FSIndexer walk; the skip result is the exact current branch expression with its measured inputs.

## 3. P2 — Plain entity_id joins and deletes scan the entire FTS table

**Confidence: current SQL, EXPLAIN plan, and isolated measurements.**

Anchors:

- [flow_sdk/db/drivers/sqlite/sqlite_driver.py:469](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/db/drivers/sqlite/sqlite_driver.py:469): `entity_id` is a plain FTS5 column, not an indexed relational lookup key.
- [flow_sdk/db/drivers/sqlite/sqlite_driver.py:661](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/db/drivers/sqlite/sqlite_driver.py:661): each upsert batch deletes by `entity_id IN (...)`.
- [flow_sdk/db/drivers/sqlite/sqlite_driver.py:711](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/db/drivers/sqlite/sqlite_driver.py:711): every nonempty upsert pays this delete path before insertion.
- [flow_sdk/db/drivers/sqlite/sqlite_driver.py:969](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/db/drivers/sqlite/sqlite_driver.py:969): browse joins FTS by `e.id = fts.entity_id`.
- [flow_sdk/db/drivers/sqlite/sqlite_driver.py:1000](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/db/drivers/sqlite/sqlite_driver.py:1000): one-row deletion uses the same plain-column predicate.

The existing LIMIT-before-join optimization bounds the number of joins but each row still scans the FTS table. The real query plan reports `SCAN fts VIRTUAL TABLE INDEX 0: LEFT-JOIN`; there is no entity_id point lookup. Browse is approximately O(page_size × total_FTS_rows), and even deleting a nonexistent ID is O(total_FTS_rows). With frequent saves this also lengthens SQLite writer-lock occupancy.

**Local benchmark:** median of seven runs, warm in-memory SQLite, six-column production FTS schema, copied production browse query, 20-row page, short synthetic text. The mapped-rowid comparison uses an explicitly aligned test insertion order only; production must persist a stable mapping and cannot assume accidental rowid alignment.

| FTS rows | Existing browse 20 | Mapped-rowid browse 20 | Delete absent entity_id |
|---:|---:|---:|---:|
| 2,000 | 5.102 ms | 0.551 ms | 0.204 ms |
| 10,000 | 24.585 ms | 2.800 ms | 0.978 ms |
| 50,000 | 114.079 ms | 12.503 ms | 4.787 ms |

These are isolated SQL timings, not measured end-to-end application latency or a promise of equivalent production speedup. The comparison intentionally keeps the entity-side sort unchanged; it exposes about 9× SQL speedup from eliminating this join scan in that workload.

**Smallest owning seam:** establish an indexed UUID→FTS rowid mapping, use FTS rowid for point joins/deletes, and enforce one FTS row per entity structurally. A mapping table is an internal lookup, not a new deterministic entity ID. Alternatively, browse can read its title/description projection from ordinary indexed storage and leave FTS exclusively for MATCH queries. Select the seam alongside the parent review's content-storage duplication finding to avoid adding a third redundant payload copy. Merely marking `entity_id UNINDEXED` would reduce tokenization but would not fix these relational lookup scans.

**Verification:** `/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/evidence/flowpad-review-index-probes.py`; `python /Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/evidence/flowpad-review-index-probes.py`. No application DB involved.

## 4. P2 — Two incompatible canonical models/renderers own the same index.md.json

**Confidence: both directions reproduced with real serializers/readers.**

Anchors:

- [flow_sdk/llm_index/index_document.py:38](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/llm_index/index_document.py:38) / `:59`: dataclass `FileRef` and `IndexData`; strict `FileRef(**f)` parsing at line 85.
- [flow_sdk/llm_index/index_document.py:169](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/llm_index/index_document.py:169): extra keys cause the sidecar to be silently treated as absent.
- [flow_sdk/fs_store/operations/markdown_index_render.py:16](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/fs_store/operations/markdown_index_render.py:16) / `:33`: parallel `FileEntry` and `IndexMdJson`; requires `rel_path`, and subfolders additionally require `child_typeid`.
- [flow_sdk/fs_store/operations/markdown_index_render.py:127](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/fs_store/operations/markdown_index_render.py:127): the other reader also returns None for incompatible input.
- [flow_sdk/llm_index/indexer.py:195](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/llm_index/indexer.py:195): prior-summary reuse consumes the dataclass reader; `_subfolder_refs` at line 225 depends on it too.
- [flow_sdk/server/routes/markdown_index.py:28](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/server/routes/markdown_index.py:28): the user-facing JSON route consumes the pydantic reader and returns `data: null` for a failed parse at line 32.

**Observed:** write a valid sidecar with `IndexMdJson`/`write_pair`; `IndexDocument.load(folder)` returns `None`. Write a valid sidecar with `IndexDocument(IndexData(...)).write`; `load_index_md_json(...)` returns `None`. One valid file entry is sufficient. Both label their schema version 1, so the persisted version cannot distinguish them.

This is already more than maintenance duplication. A library-generated index appears absent through the route; an agent-generated index has no readable prior for library summary reuse, losing the opportunity to reuse unchanged folder summaries or quote child summaries. The two renderers additionally generate different links (wiki links vs ordinary relative Markdown links).

**Smallest owning seam:** one canonical versioned model and deterministic renderer in the standalone index library, plus explicit migration/compatibility loaders for both shipped version-1 layouts. The server and agent renderer become thin adapters. Preserve file relative paths/size and child identity in the canonical form where needed, and share roundtrip tests across both callers. Do not merge the whole FSIndexer and LLMIndexer: their outputs and responsibilities are genuinely different; the duplicate sidecar model/renderer is the actual overlap.

**Verification:** `/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/evidence/flowpad-review-sidecars.py`; `uv run python /Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/evidence/flowpad-review-sidecars.py`. Both outputs are `None`, with files contained in an automatically deleted temporary directory.

## Other reviewed boundaries

The transcript indexer is explicitly opt-in and absent from `build_default_indexer`; its expensive full-JSONL passes are therefore not presented here as a production default-scan bottleneck. Existing FTS batching, commit-before-sentinel ordering, the shared gitignore walker, and the separation of deterministic LLM planning from model calls are useful seams to retain. The duplicated Entity→store→FTS write suspected from older docs does not occur in disk→DB sync: `Entity.from_record` now suppresses store with `_SUPPRESS_STORE` at `entity_model.py:1144`.

Documentation should be updated after fixes: search docs openly describe truncated post-filter paging, but the migration comment promises a recovery that the current freshness model cannot provide; the LLM-index docs describe incompatible formats as a gotcha rather than an interoperability failure. The static performance claim for MATCH alone must not be used to estimate the whole browse/query pipeline.
