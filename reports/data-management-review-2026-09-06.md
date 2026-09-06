**Data-management review — records, entities, assets, discovery and indexing**

Reviewed 2026-09-06 against HEAD `14635091fdd671558cb209b99a84409aaf3788b5` and the current working tree. Four review agents covered records/entities, assets/identity, scanning/discovery, and indexing/search. The lead reviewed SDK integration, checked the findings across areas, and removed one unsupported integration claim. Existing application edits were preserved. This submission contains the report and supporting probes; it implements no fixes.

**Architectural follow-up:** the requested [alternative removing the Entity layer](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/record-only-architecture.md) recommends one typed record model, optional asset storage and one-way index projections. It reassesses ownership, migration risk and SLOC scope. That proposed direction supersedes this report's initial recommendation to retain the layer separation; the findings and bounded consolidation estimates below still describe the reviewed implementation.

The largest opportunities are at the boundaries between the layers: authoritative writes, identity resolution, projection completion, filesystem enumeration, and query ownership. Several parallel implementations already disagree in observable ways. Fixing those disagreements and consolidating their shared work offers substantial robustness and code reduction without changing the useful record/entity/asset separation.

**What the model should preserve**

Assets hold source content. `TypeInfo` owns each type's identity carrier, layout, parser and serializer. `FSRecord` carries the disk metadata or parsed source snapshot. Entity rows, FTS and wiki edges provide query projections. The SDK caches backend entities and delivers changes to views.

That model needs an explicit exception for authoritative DB-only state: source items, ingestion cursors/consumer positions and tabs currently skip shadows. The claim that the entire database is disposable does not describe all current types. Define the recovery contract per storage category before changing rebuild or backup behavior.

Preserve the single concrete FSRecord, central type registry, UUID v4/v5 adoption rules and natural-key lookup, shared gitignore walker, task-aware record lock, WAL read/write separation, and commit-before-sentinel ordering already present in the bulk indexer. Preserve the distinction between filesystem discovery and the LLM folder-index generator; their overlapping sidecar representation is the part to consolidate.

**Correctness priorities**

P1 means a material persistence, identity, rebuild or search-correctness problem to address first. P2 means a significant robustness or efficiency problem. “Reproduced” below means an isolated probe using actual implementation code; it does not imply a production incident or full end-to-end validation.

| Priority | Finding and evidence | Owning fix |
|---|---|---|
| P1 | **Incomplete scans remove live records.** An empty/gated discovery scope classified an existing source's shadow as orphan. A real SQLite probe removed its DB row and shadow while the source file remained present. [Scan findings](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/scan.md) | Use the same source-existence/reachability predicate for every candidate. Record discovery completeness; retain uncertain candidates. |
| P1 | **Scoped rebuild clears globally before acquiring the index guard.** Type-wide deletion ignores project scope, then reconstruction uses the narrower scope. Clearing occurs before the job queues behind an existing index. Confirmed by control flow. [Rebuild path](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/builtin/faas/fs_records_actions.py:1670) | Acquire shared mutation ownership before reset; use identical clear/rebuild scope. |
| P1 | **Successful fs-records PUT does not write the source asset.** The real handler returned success and updated DB fields; source bytes stayed unchanged. Fresh reindex restored the old title. [Persistence findings, RE3](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/records-entities.md) | Route edits through the authoritative typed serializer, then rebuild projections. |
| P1 | **GET refresh marks stale content fresh without reparsing it.** The source changed, but refresh re-used shadow fields, retained old FTS/body reload timestamp, and stamped a fresh sentinel. Reproduced. [Refresh code](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/core/entity/entity_model.py:1518) | Fresh-parse the source under the record guard; stamp the successfully committed snapshot. |
| P1 | **Explicit field clears are not durable.** Setting `group_id=None` clears the DB but leaves the old value in the shadow. Reindex restores the old parent. Reproduced with real Group rows. [Persistence findings, RE2](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/records-entities.md) | Distinguish omitted fields from explicit clears using changed-field ownership or tombstones. Preserve protection against stale partial writes. |
| P1 | **Concurrent carrier minting forks identity.** Sixteen concurrent minters on one new markdown file returned multiple IDs in four of five trials; one ID remained on disk. Atomic replacement does not make read/check/write indivisible. [Identity findings, A1](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/assets.md) | Use one canonical-path carrier transaction for check, adoption, rendering and write; return the committed winner. |
| P1 | **Change events escape before commit.** Injecting an FTS failure after a real row write produced a creation event although the transaction rolled back and the row was absent. Delete publication also precedes deletion. [Persistence findings, RE4](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/records-entities.md) | Queue immutable events in the transaction owner; publish after commit and discard on rollback. |
| P1 | **Search pagination hides valid matches and repeats pages.** Real route probes returned identical FaaS text-search pages for offsets 0 and 2, empty filtered results with two real matches, and `total=2` for six matches. [Search findings, item 1](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/index-search.md) | One backend query service; apply predicates and ordering before pagination, with an accurate pre-page count. |
| P1 | **FTS migration leaves an empty search index marked fresh.** Real driver migration preserved one Entity row and its current sentinel while removing its FTS row. The normal-index skip condition still evaluates true. [Generation finding](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/index-search.md) | Include index generation and producer revision in completion tokens; invalidate projections when their format or extractor changes. |
| P2 | **Child tasks inherit their parent's AsyncSession.** The session ContextVar has no task/driver owner check. A child task received the exact same session; ordinary async tag consumers can reach this path. Session sharing was reproduced; downstream concurrency failures were not. [Persistence findings, RE5](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/records-entities.md) | Bind session reuse to its owning task and driver; preserve same-task nesting. |

**Further material defects**

File-level gitignore exclusions are lost between directory traversal and markdown/spreadsheet emitters. A temporary project excluded `private.md` and `private.csv`; the canonical walk respected both exclusions, but FSIndexer still emitted both files. Retain the walk's filtered file candidates instead of listing each directory again. This fixes correctness and repeated I/O together. [Scan findings, items 3–4](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/scan.md)

Identity handling has two additional ownership gaps. Scan preview calls the minter without the existing path-owner inventory, so a carrier-wiping rewrite can cause preview to stamp a replacement ID. Separately, owned serializer rendering writes the proposed ID before checking the existing carrier; two real Agent objects stored at one temporary origin replaced the first carrier with the second ID. Ordinary fresh Entity creates already have collision guards, so the serializer result is scoped to direct storage and stale/existing-object updates. Both belong in the shared identity transaction above. [Scan item 6](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/scan.md), [asset A3](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/assets.md)

The SDK's cold watch path registers the same callback twice, and unsubscribe removes only one registration. The real DataManager probe measured `{registered: 2, remaining: 1}` instead of `{registered: 1, remaining: 0}`. Separate query-cache creation from subscription registration so there is one lifecycle owner. [SDK1](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/sdk.md)

Asset search uses a shared cancellation ref that the next request resets. Completing an older request after a newer one replaced the current results with old results in a real React hook probe. The sibling record-search hook already handles this case correctly; its two existing tests passed. Share request lifecycle handling and use per-request ownership. [SDK2](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/sdk.md)

`FSRef.children()` drops inherited read-only, scope and project information; `delete()` and `mkdir()` omit read-only checks. Temporary-file probes confirmed writable listed children and deletion through a read-only ref. This is a verified primitive contract defect; no affected production call chain was established. `Entity._storage_origin` already rejects explicit read-only refs before serializer entry, so a proposed bypass at that boundary was rejected during consolidation. [Asset A2](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/assets.md)

Two models and renderers both claim the canonical `index.md.json` format, version 1, but reject one another's valid output. Both directions returned `None` in real roundtrip probes. This makes valid generated indexes appear absent to another reader and prevents prior-summary reuse. Define one versioned format and renderer, with compatibility readers for both existing layouts. [Index/search item 4](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/index-search.md)

**Largest optimization, compression and code-reduction opportunities**

| Opportunity | Current evidence | Concrete target |
|---|---|---|
| **Use indexed FTS identity lookup** | Browsing 20 rows over 50,000 FTS rows took a 114 ms median in the isolated SQL benchmark; an explicitly mapped-rowid variant took 12.5 ms. Existing joins scan FTS for each result. | Persist an indexed UUID→FTS rowid mapping and use point joins/deletes, or keep browse metadata in its existing ordinary projection. Preserve entity UUIDs. The approximately 9× result is for this SQL workload only. |
| **Enumerate each directory once** | A 101-directory mixed markdown/CSV tree caused 303 enumerations. `limit=1` still traversed all 101 directories before returning. | An incremental, filtered directory/file stream shared by classifiers. Target one enumeration per directory and early progress/cancellation boundaries. |
| **Read and parse one asset snapshot once** | A real Agent serializer load read the same markdown file three times for header, body and identity. | Pass one immutable source snapshot and already-resolved identity through parsing/projection. Target three reads to one; also avoid combining different file revisions. |
| **Remove duplicate persisted body content** | A 1,000,000-character Markdown body produced a 1,000,051-byte source and a 2,000,937-byte shadow, storing the body again as `content`. FTS stores another copy. | Derive FTS content from canonical fields instead of persisting another identical string. About half of this example's shadow can disappear. Audit consumers before making source bodies entirely transient. |
| **Select a page before loading full records** | Generic RecordList queries load every shadow, then filter/sort/slice. REST browse hydrates the whole type. | Use the existing SQLite query layer to select/count IDs, then hydrate only the requested page. Retain disk enumeration for explicit recovery/unindexed discovery. |
| **Stop parsing whole corpora for resource counts** | Resource summaries call the full parser pipeline; project projection runs six typed scans and repeats each source-map read. Parsing occurs synchronously inside async functions. | One multi-type discovery/projection pass; load each ownership inventory once; count candidates and materialize only necessary payloads in bounded worker batches. |
| **Collapse the parallel search handlers** | The REST and FaaS handlers occupy approximately 219 and 158 lines and disagree on filters, offsets, totals and calibration. UI time filtering adds another post-page filter. | One typed backend search/browse implementation with thin wire adapters. This is a consolidation surface, not a promise that all 377 lines disappear. |
| **Share persistence and schema primitives** | Atomic replacement logic is duplicated in capsules/frontmatter; shadows still use direct truncating writes. TypeMetadata/TypeInfo repeat declarations. Record→entity normalization has two implementations and legacy branches. | One atomic byte writer with consistent error handling; one declaration shape; one pure field-normalization function. Keep authority, locking and type-specific behavior explicit. |
| **Unify LLM index sidecars** | Two schemas, parsers and renderers produce incompatible files with the same format/version label. | One canonical model/renderer plus migration adapters. Keep deterministic LLM planning independent from Entity/DB code. |

Removing repeated representations and orchestration should precede physical compression. It reduces bytes, parse work and inconsistent update paths together. No credible repository-wide LOC or latency percentage can be promised before implementing and measuring these changes.

**SLOC reduction estimate — added 2026-09-06**

**Plan for approximately 500 net production SLOC removed overall, with a 300–720 range.** Consolidation alone is estimated to remove 500–822 SLOC after accounting for replacement helpers, shared query logic, and compatibility adapters. The complete correctness package is likely to add a further 100–200 SLOC for transaction event ownership, session ownership, generation invalidation, explicit clears, and cleanup completeness. The resulting estimate is 300–722 SLOC net reduction, rounded above. These are engineering estimates, not measured deletions from an implemented diff.

The current **measured candidate footprint is 2,492 SLOC across selected, non-overlapping blocks in 16 files** at HEAD `abb4a1274d50b4bc9435cfb6845616cfe594ff8c`. It is not the size of the entire data-management subsystem. This follow-up measures the current checkout; it does not credit unrelated concurrent refactors as proposed savings.

| Consolidation | Measured candidate SLOC | Estimated net reduction | Assumption |
|---|---:|---:|---|
| Scan/resource/preview projections | 527 | **130–220** | Share identity, freshness, collision and normalization work; retain distinct response shapes and incremental scan safeguards. |
| Record CRUD/query/normalization | 460 | **100–170** | Reuse typed persistence and SQL queries; retain route compatibility and an explicit unindexed recovery path. |
| Backend search/browse | 369 | **100–160** | One query service replaces parallel orchestration; SQL predicate/count work and both route adapters are included in the replacement budget. |
| Frontend search hooks | 229 | **50–85** | Share request ownership/state and query construction; retain presentation adapters, calibration and result types. |
| LLM sidecar models/renderers | 210 | **60–90** | One canonical format/renderer; preserve compatibility readers for both shipped formats and the CLI adapter. |
| TypeMetadata/TypeInfo declarations | 118 | **35–50** | Share declared slots while retaining runtime binding, merge rules and distinct responsibilities. |
| Atomic write helpers | 61 | **15–22** | Keep one writer and any text/bytes adapter; retain locking, permission preservation, cleanup and fsync. |
| SDK query subscription lifecycle | 518 | **10–25** | Remove duplicate registration/cleanup ownership; preserve the query grammar, cache, and pending-request deduplication. Most of this footprint remains. |
| **Consolidation total** | **2,492** | **500–822** | Replacement code is already deducted; source blocks do not overlap. |
| Additional correctness infrastructure | — | **−100 to −200** | Estimated added production code beyond the consolidation replacements. |
| **Full package, net** | — | **300–722 removed** | Excludes new/changed tests and documentation. |

Consolidation would remove approximately **20–33% of these selected blocks**. This percentage must not be applied to the whole repository or subsystem. The strongest reduction targets are shared scan projection, record persistence/query routing, and the two search paths. API deprecation could permit further deletion, but consumer compatibility has not been established, so that upside is excluded.

SLOC here means physical nonblank source lines containing code, excluding comments and Python docstrings. Runtime string literals, SQL strings, decorators and type declarations count. Python is counted using AST/token information; TypeScript uses compiler token spans. Moving code into a helper earns no savings unless total production SLOC falls. Tests, reports, generated files, formatting-only changes and comment removal are outside the estimate. The shadow-body and FTS improvements mainly save bytes and runtime; no additional SLOC savings are claimed for them.

The source blocks and measured counts are recorded in [sloc-counts.json](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/evidence/sloc-counts.json); [count_sloc.py](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/evidence/count_sloc.py) reproduces the baseline from the repository root. The counter measures existing code only; the reduction ranges require implementation judgment. Confidence is medium for the aggregate and lower where route/recovery compatibility limits deletion. Regression tests will add code and are intentionally reported separately from production SLOC.

**Risk assessment — added 2026-09-06**

The complete refactor has **high implementation risk if combined into one change**. The highest risks are source/identity writes, two-way record synchronization, destructive scan cleanup, transaction/event ownership and persisted-format migration. Several existing defects in these areas are already reproduced, so narrow correctness repairs take priority even when they add code.

| Area | Change risk | Primary protection |
|---|---|---|
| Search and SDK consolidation | Low–medium for SDK; medium for SQL/API behavior | Preserve response adapters; independently verify filters, pages and consumer lifecycles. |
| Record/asset persistence and identity | High | Type-aware roundtrips, stable IDs, explicit-clear semantics, shared lock ordering and recoverable source snapshots. |
| Scan and orphan/rebuild behavior | High | Prove source absence and scope completeness; retain collision ownership; separate cleanup checks from faster enumeration. |
| Transaction events and session ownership | High | Publish after the actual outer commit; isolate child sessions; exercise rollback and async consumers. |
| FTS/sidecar/storage migrations | Medium–high; high for unproven content deletion | Compatible readers, interruption recovery, verified projection backfill, preservation of authoritative DB-only state. |
| Shared declarations and byte writers | Medium despite small SLOC savings | Verify every type's defaults/hooks and preserve byte, permission, mtime and path semantics. |

The search/SDK portion offers an estimated **160–270 net SLOC reduction** with relatively tractable rollback. Source mutations and migrations require data recovery planning: reverting code does not undo rewritten carriers, removed metadata or already-triggered workflow effects. The full-package SLOC estimate can fall below 300 if compatibility or hardening needs exceed the current allowance; correctness and recovery are the acceptance criteria.

The [detailed risk analysis](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/risk.md) covers each consolidation, coupled failure modes, validation requirements, rollout order, rollback limits and estimate uncertainty. This is analysis only; no fixes, migrations or deployments were executed.

**Documentation findings**

The review read the data-management overview/index, record model, entity-index sync, database, invalidation, scan/discovery, search, FSRef, capsules, DataSpec, source-asset, transcript-indexing and LLM-index documentation. The detailed reports list exact contradictions and drift.

The consequential corrections are: identify authoritative DB-only state; describe explicit-null persistence; make GET freshness mean a fresh source parse; distinguish source absence from incomplete enumeration; document rebuild scope and guard ownership; and describe one valid sidecar format. Smaller drift includes current warning envelopes, `main_ref` resolving an inner body, data-source-spec identity using manifest name, current activity queueing, and reader-session behavior. The docs index also contains stale descriptions of database pooling.

Do not infer a duplicate FTS write from older descriptions: current disk→DB adoption suppresses Entity.store, so that suspected duplication was rejected. The opt-in transcript pass was also excluded from claims about ordinary default-scan cost.

**Suggested execution order**

1. Make persistence and destructive operations trustworthy: fix source writes, explicit clears, fresh parsing, orphan evidence, scoped reset ownership and carrier transactions. Add roundtrip regressions that edit, reload and reindex.
2. Fix transaction/event/session ownership and index-generation recovery. Verify observers see committed projections, rollbacks publish nothing, and unchanged sources recover after FTS migration.
3. Consolidate discovery and query services, then remove duplicate content, reads, parsers and subscription registration. Measure directory enumerations, parsed bytes, SQL plans, callback counts and peak memory against the same fixtures.
4. Unify sidecar/schema/write primitives and update the documentation to the resulting behavior. Establish a restore test that preserves authoritative DB-only state and reconstructs the declared projections.

No step requires larger waits, retry budgets, a new identifier scheme, or an additional persistence protocol.

**Evidence and validation limits**

The reviewers used temporary files and SQLite databases. Probes reproduced stale refresh, nullable-field resurrection, ineffective PUT, rolled-back creation events, cross-task session reuse, live-record orphan cleanup, gitignore leakage, competing identities, incorrect paging, FTS migration state, sidecar incompatibility, SDK callback leakage and the search-response race. A few findings are control-flow proofs, and those are identified above and in the area reports. The FTS migration probe tested the real migration and freshness inputs, then evaluated the exact skip condition; it did not execute a complete post-migration FSIndexer walk.

Measurements are synthetic operation counts, storage sizes and local SQL timings. They are not production workload benchmarks. The complete regression suite, browser E2E, power-loss recovery and deployed environments were not exercised. No live instance data was modified. Review-only frontend tests were removed from the application test tree after execution; their source is archived with the other probes.

| Detailed area report | Coverage |
|---|---|
| [Records and entities](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/records-entities.md) | Five reproduced persistence/transaction findings, shadow storage, collection queries, normalization and durability contracts |
| [Assets and identity](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/assets.md) | Carrier concurrency/ownership, FSRef guarantees, serialization, read duplication and declaration/writer consolidation |
| [Scan and discovery](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/scan.md) | Orphan/rebuild safety, ignores, enumeration, projections, identity and root policy |
| [Index and search](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/index-search.md) | Query correctness, index generation, FTS query plans and sidecar interoperability |
| [SDK integration](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/sdk.md) | Reproduced watch leak/search race, query ownership and frontend filtering |
| [Risk analysis](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/risk.md) | Implementation risk, migration/rollback boundaries, acceptance criteria and staged rollout |
| [Evidence notes and probes](/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/evidence/README.md) | Archived small reproduction programs and their execution context |
