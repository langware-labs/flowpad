# Scan and discovery review — 2026-09-06

Scope: current working tree, read-only review of `FSIndexer`, directory/provider walkers, scan projections and HTTP job boundaries. Read the slick skill, `docs/CLAUDE.md`, the data-management index, scan-and-discovery, and compute-node-fs-records documentation. Product files were not changed. Four isolated probes used temporary source directories; the destructive-orphan probe also used a temporary real SQLite database and test instance settings. No live instance was mutated.

## 1. P1 — Incomplete discovery deletes the index and shadow of a source that still exists

Confidence: confirmed with real SQLite and real `FSIndexer.index`, no mocks.

Evidence:

- [flow_sdk/fs_store/indexer/index_function.py:1279](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/fs_store/indexer/index_function.py:1279): `missing = sorted((disk_ids - seen) | db_missing)` declares every unseen shadow id orphan, without inspecting its source.
- The existence/unreachable checks in `_db_missing_orphans` at `index_function.py:405–410` explicitly exclude `eid in disk_ids`. Having a shadow directory therefore removes the protection a DB-only row receives.
- `flow_sdk/fs_store/fs_record.py:819–831` defines the intended predicate correctly: a declared source must be absent, and its parent must still be reachable.
- `_resolve_scoped_roots` skips gated/missing roots (`fs_records_actions.py:143–175`) and returns `()` when every requested root was skipped (`197–206`), while the original scope still reaches the sweep.
- `index_function.py:979–980` enforces `limit_per_type` before recording `seen_ids` at `991–992`, so even discovered live records above the cap are considered unseen.
- `fs_records_actions.py:1627–1640` also permits a path-limited run while retaining the wider scope filter; only non-path destructive runs expand the roots globally.
- `_apply_orphan_action` at `index_function.py:1493–1507` removes DB/FTS/wiki data and the shadow directory; it never removes the source file.

Trigger: index a file normally, then run `orphan_action=delete` after its project has been gated/skipped, or under a cap/path-limited run that misses it. A populated scope filter satisfies the current narrowing safety check even though it does not prove complete discovery.

Isolated reproduction: seeded one valid `markdown` DB row, matching `metadata.json` shadow, and an existing `still-present.md`. Called `FSIndexer([]).index(IndexerOptions(roots=(), types=[MARKDOWN], scope_filter=ScopeFilter(user=True), orphan_action=DELETE))`.

```text
BEFORE source_exists=True, shadow_exists=True, row_exists=True
AFTER  source_exists=True, shadow_exists=False, row_exists=False
       orphans_found=1, rows_removed=1, shadows_removed=1
```

Impact: live assets disappear from the entity/search graph and their shadow metadata is removed. The original asset bytes survive; this is not deletion of the source file. Correctness currently depends on enumeration completeness that several normal code paths explicitly cannot guarantee.

Smallest fix seam: use one source-state predicate for both shadow-backed and DB-only candidates, reusing the `FSRecord.orphan`/`source_unreachable` rule. Treat unknown/unreachable sources as retained, and make discovery report incomplete/gated/capped roots so destructive cleanup can refuse uncertain candidates. Populate seen identity for every successfully probed candidate before applying parse limits. Preserve same-path duplicate removal as a separate positive-evidence operation.

Verification: temporary real DB regression cases for live-but-unseen, gated root, disconnected root, per-type cap, and genuinely deleted file. Assert DB, shadow, source and wiki outcomes separately.

Related completeness gap: `_resolve_orphan_filter_types(None)` at `index_function.py:1409–1417` returns only types whose directory still exists, despite the comment claiming a DB+disk union. A DB-only orphan of a type whose whole shadow type directory was removed is not checked by an untyped run.

## 2. P1 — Rebuild clears globally and before acquiring the index activity

Confidence: high, direct control-flow proof; shared with parent for downstream index-review deduplication.

Evidence: `fs_records_actions.py:1670–1680` executes `delete_entities_by_type` for every selected type, clears its hash sentinels, and optionally clears all FTS. Only afterward does `1688–1706` call `_run_index_activity`, whose guard is acquired at `1310`. Neither type-wide deletion nor `fts_clear` uses the scope filter.

Trigger: `POST /fs-records/index?rebuild=true&projects=<one project>` clears records for other projects too, then repopulates only the selected project. If another index already runs, the rebuild deletes rows/sentinels while that job is writing and only queues after the deletion. Its failure or cancellation can leave an empty/partial index.

Smallest fix seam: put reset and rebuild inside one shared activity/DB lifecycle operation. Apply the same scope to clearing and reconstruction, or explicitly make this API require a global scope when rebuilding globally. Coordinate `clear` with the same mutation lock; the current per-job-name slots are not mutual exclusion between clear and index.

Verification: seed two projects, rebuild one, assert the other remains queryable. Pause one indexing operation at an actual transaction boundary; start a rebuild and assert no deletion precedes ownership of the shared job.

## 3. P2 — File-level gitignore exclusions disappear between the walk and leaf emitters

Confidence: confirmed on temporary files using real walkers.

Evidence: `project_folder_walker.py:65–71` calls `gitignore_walk(..., include_files=False)` and retains only folder paths. `walk.py:88–100` skips files before applying ignore rules. `markdown.py:145–165` then globs all direct `.md` files and `spreadsheet.py:59–78` independently lists all CSV/XLSX files; neither applies the saved ignore stack or a file predicate.

Probe: a temporary project had `.gitignore` containing `private.md` and `private.csv`, plus public files of each kind.

```text
canonical gitignore_walk: .gitignore, public.csv, public.md
FSIndexer scan:          private.csv, private.md, public.csv, public.md
```

Impact: files explicitly excluded by the project are still parsed, indexed and potentially given identity frontmatter on an index run. This also wastes work on generated large files. Existing folder-walker tests reproduce the same folder-only filtering in their expected-value helper, so that test cannot catch file exclusions (`tests/unit/test_fs_store/test_indexer_folder_walker.py:39–88`).

Smallest fix seam: retain already-filtered file candidates from the shared walker and have type classifiers consume them. Keep the documented `.claude` force-include exception deliberate. Do not independently reload/parse the full gitignore ancestry per file.

Verification: root and nested gitignore files, explicit filenames and extension patterns, `.claude` force inclusion, markdown and spreadsheet assets.

## 4. P2 — Directory discovery is repeatedly enumerated and its eager root walker defeats bounded progress

Confidence: confirmed call counts with temporary filesystem and instrumentation around actual directory enumerators.

Evidence:

- `project_folder_walker.py:44–72` exhausts the entire tree into a list before returning any children to `FSIndexer`.
- `index_function.py:1610–1622` invokes that synchronous function and only checks `opts.limit` after it has returned. The 256-node chunk boundary cannot preempt one whole-tree function call.
- `markdown.py:146` and `spreadsheet.py:61` re-enumerate each directory the shared `gitignore_walk` already enumerated.
- `scan_child.py:105–128` also waits for the complete `scan()` result before emitting candidates. The NDJSON transport does not make enumeration streaming.

Probe: 100 subdirectories, one markdown and one CSV in each (101 directories including root):

```text
Full scan: 302 refs, 303 directory enumerations
           101 shared os.scandir + 101 markdown glob scans + 101 spreadsheet lists
limit=1:   1 returned ref, but all 101 directories still enumerated
```

Impact: at least a 3-to-1 enumeration opportunity for this common combination, plus repeated sorting/stat work and complete in-memory folder/ref/probe collections. Progress can stay frozen for the entire largest root, and cancellation of the awaiting coroutine does not stop an already running synchronous tree traversal. This is not a claim of a measured 3x overall index speedup; parsing and database costs remain.

Smallest fix seam: make directory traversal incrementally yield filtered directory/file batches to type classifiers, keeping the current type registry/dispatch model. Reuse the same `DirEntry` facts within each batch. Collision resolution can still retain the compact identity/path inventory that must be globally ranked; it need not force repeated directory enumeration or full parser objects to remain live.

Verification: count enumerations in a synthetic tree; assert one per visited directory for mixed types, an early progress event before exhausting a large tree, and a cancelled/bounded discovery stops further enumeration without a longer timeout.

## 5. P2 — Resource-browser scans eagerly parse entire corpora on the event loop, even for a count or small page

Confidence: high, direct call-chain proof.

Evidence:

- `scan_indexer.py:119–125` synchronously resolves paths and reads/writes identity in an async function.
- `scan_indexer.py:170–188` synchronously runs every `from_disk` parser and normalization on the event loop; the `to_thread` at `154` offloads only collision resolution.
- `scan_resources_from_indexer` calls `_walk_type_records` at `245` before applying time/parent filters (`247–254`) and pagination (`258–264`). Asking for one row parses every candidate.
- `get_resource_summary_from_indexer` at `295–301` invokes that same full parser projection solely to compute `len(items)` for all nine resource types. For Claude sessions this includes reading transcript contents/statistics.
- `_walk_type_records` loads `list_entity_sources_by_type` at `206`; `_project_nodes` loads the identical table again at `114`.
- `scan_project_from_indexer:397–400` invokes six separate typed scans, despite the comment at `387` claiming one walk; it also synchronously parses up to the requested session count at `381–384`.

Impact: resource pages and count summaries scale with all source content, not the requested page or number of refs, and can block unrelated HTTP/WebSocket work on the event loop. Each ordinary per-type request does two identical source-table reads; a project request does six walks and twelve source-table reads before rendering its six buckets.

Smallest fix seam: one reusable identity/collision projection shared by scan consumers; pass the one preloaded source map into it. Summary uses the deduplicated candidate inventory without parsing content. Project scan requests all six types in one dispatch pass. For listing, apply path/mtime filters and page selection before payload parsing wherever the response semantics permit; use bounded worker batches for remaining synchronous parsing. This is a good code-reduction seam because both `scan_indexer.py` and fs-records projections repeat identity/freshness/normalization orchestration currently owned more completely by `FSIndexer`.

Verification: instrument parser calls and source queries with 1,000 candidates, `limit=10`; counts should not parse 1,000 payloads. Verify summary counts agree with list identity/collision semantics. Test an event-loop heartbeat during large session projection and ensure it is not delayed by one complete synchronous corpus pass.

## 6. P2 — Scan preview bypasses the existing-path identity owner lookup

Confidence: confirmed with a temporary markdown source and the actual TypeInfo/scan helper.

Evidence: `fs_records_actions.py:653` `_ref_id` calls `info.mint_entity_id(ref)` without `owner_id` or `live_ids`; its callers are the per-type preview at `735` and the diff at `775`. The main indexer correctly preloads owners and passes both at `index_function.py:810–814`; the resource browser independently implements this correctly at `scan_indexer.py:112–125`.

Trigger: an external rewrite removes the identity carrier from an already indexed writable markdown file; scan preview runs before the next actual index. It mints/writes a new identity despite the existing row owning the path.

Probe: a source without its carrier, representing that rewrite, produced a different preview UUID and wrote it into the source. Calling the canonical seam with the incumbent owner/live ids restored the old identity on the subsequent index. The isolated probe used an incumbent id supplied as the known owner rather than querying a live DB.

Impact: preview reports a new nonexistent entity id and dirty source bytes; identity oscillates until the next owner-aware index, and preview links/counts can disagree with indexed entities in the meantime.

Smallest fix seam: route all scan projection identity resolution through the same preloaded owner inventory, or use a non-mutating preview identity read with the owner fallback. Do not add a database lookup per file. Consolidate this with finding 5's projection seam.

Verification: real temporary DB row + source whose frontmatter is overwritten, invoke the actual scan preview, assert it reports/persists the original entity id and does not classify that entity as newly minted.

## Additional bounded robustness concern: project scan bypasses canonical root policy

`scan_actions.py:437` directly calls `scan_project_from_indexer`; `scan_indexer.py:390–396` fabricates a root without `_resolve_scoped_roots`, `gate_root`, or `Folder.borrowed_checkout_paths` read-only marking. The latter two are enforced by the canonical resolver (`fs_records_actions.py:119`, `166`, `185`). Projection then mints writable identities. Consequently a scan of a known borrowed project can write identity carriers into it, and protected-root consent semantics differ from the other scan endpoints. Confidence: high static proof, not exercised against real protected/borrowed directories. Fix by routing project selection through the same resolver before the single multi-type scan.

## Documentation conflicts

- `docs/CLAUDE.md` and `scan-and-discovery.md` define orphan as missing source; current shadow-backed sweep instead means not seen in this walk (finding 1).
- `scan-and-discovery.md` describes bounded chunked discovery; the nested eager project-root walker has no batch/yield boundary (finding 4).
- `scan-and-discovery.md` says all resource actions use scoped roots resolved by `_scan_scoped_roots`; scan-project builds its own root (additional concern).
- `compute-node-fs-records.md` says same-name concurrent index returns 409 and `_COMPUTE_ACTIVITIES` owns single flight; HTTP index now passes `queue=True`, and `Activity.try_claim` owns liveness (`compute_node.py:130–171`).
- `scan-and-discovery.md` says concurrent read transactions still use `BEGIN IMMEDIATE`; `flow_sdk/db/__init__.py:16–34` now supports `session(write=False)` and downstream callers must be assessed individually.
- Several complexity statements omit content size: full resource projection reads transcript/asset contents, making it O(total parsed bytes) plus sorting; `FSIndexer.index` also has stored-inventory/collision/orphan work beyond O(V+R).

## Prioritized implementation sequence

1. Fix destructive-orphan evidence and rebuild mutation scope/serialization before performance changes.
2. Centralize a filtered, incremental directory stream: it fixes gitignore correctness and removes repeated enumeration together.
3. Centralize candidate identity/collision projection for index, previews and resource browser; reuse one source-map read and one project scan.
4. Separate summary/candidate inventory from payload materialization; parse only what the response needs and keep blocking I/O off the event loop.

No numeric lines-of-code saving is asserted without implementing and measuring a diff. The strongest compression opportunity is removing parallel orchestration, not removing the existing type-specific metadata or safety checks. Preserve the good current seams: the single TypeInfo identity resolver, `gitignore_walk`, post-commit sentinel stamping, explicit terminal subprocess result validation, and child cleanup on cancellation.
