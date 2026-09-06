# Asset, identity, FSRef and serializer review

Review date: 2026-09-06. Read-only review of current working tree. Applied slick lens; read docs/CLAUDE.md, docs/data-management/asset-capsules.md, record-model.md, schema-registry.md, data-source-asset.md, compute-node-fs-records.md, docs/fs-ref.md, docs/fs_store.md. No product code edits or instance database changes. Existing user edits were left untouched.

## A1 — P1: markdown identity adoption is not atomic across writers

**Confidence: high; reproduced.** [flow_sdk/fs_store/identity_carrier.py:167](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/fs_store/identity_carrier.py:167) reads a carrier, reads the file again, atomically replaces it, and returns its own proposed id. Atomic replacement prevents torn bytes but does not make this check-and-set indivisible. `NativeJsonCarrier.write_if_absent` at approximately line 242 has the same pattern. Folder capsules already solve it with the per-path `capsule_lock` in [flow_sdk/capsules/atomic.py:14](/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/capsules/atomic.py:14).

**Trigger:** two concurrent calls to `TypeInfo.mint_entity_id` for the same absent markdown carrier (`schema_registry.py:612-615`). The seam is reached by full scan/index, single-file discovery/reindex (`builtin/faas/fs_records_actions.py:2798`), serializer storage, and multiple processes/checkouts indexing a shared source directory. No cross-process or cross-entry-point path lock surrounds the markdown carrier's read/write. This is a race over one source file, independent of any separate problem with stale or duplicate installed instances.

**Isolated repro:** actual FSRef, TypeInfo and FrontmatterCarrier, a fresh temp markdown file per trial, 16 worker threads synchronized at a barrier before `mint_entity_id`; no sleeps, fake methods, DB or network. Five trials returned **6, 1, 12, 8, 10 distinct ids per file**. One id remained on disk; several successful callers held identities that the file never retained. Consequences include orphan/forked shadow rows and inconsistent parent references depending on which result callers persist. A production DB corruption instance was not exercised.

**Smallest fix seam:** protect the entire identity check/read-modify-write using the existing shared canonical-path carrier lock, and return the actual committed winner. Use the same path lock for markdown/native JSON and owned rendering/conversion so their writers cannot interleave. Preserve UUID v4/v5 policy and natural-key ownership rules; do not change identifiers or add retries/timeouts. Check the owner-restamp branch (`schema_registry.py:598-603`) too: it currently discards the writer's returned winner.

**Verification:** concurrent-minter test must yield exactly one identity equal to `read_id`, with body/capsules preserved; competing body edit and identity stamp must retain both. Include native-JSON and owner-restamp variants.

## A2 — P2: FSRef traversal and mutation methods violate read-only/provenance contracts

**Confidence: high; reproduced at the primitive.**

- `fs_store/fs_ref/base.py:155-158`: `children()` constructs `FSRef(p)` with no parent. In contrast `child()` at 112 passes `parent=self`. Listed descendants lose inherited `read_only`, scope and project id.
- `base.py:144-153`: `delete()` and `mkdir()` do not check read-only at all; `delete()` recursively removes a directory even when the ref is read-only.

**Isolated repro:** a parent FSRef flagged read-only/scope=system/project_id=project returned a listed child with `False/None/None`; the child wrote successfully. A separately constructed read-only child ref then deleted the file successfully. No instance data touched.

**Scope correction:** no Entity.store bypass is claimed. `Entity._storage_origin` (`core/entity/entity_model.py:1430-1437`) explicitly rejects a read-only ref before calling the serializer. The earlier observation that `_asset_ref_is_borrowed` returns False for explicit read-only refs does not bypass that guard. Existing production callers of the defective FSRef traversal/delete methods were not established, so this is a proven exported-primitive contract gap, not an observed UI/backend data-loss incident.

**Smallest fix seam:** have `children()` delegate to `child()` and guard all mutation methods, including delete/mkdir, using the same read-only predicate as write(). Preserve the distinction between external origins and read-only policy and retain Entity's existing serializer-entry guard.

**Verification:** all primitive mutations reject a read-only root and its child()/children() descendants; scope/project provenance remains identical through both traversal APIs. Preserve the existing Entity._storage_origin rejection test/behavior.

## A3 — P2: owned serializer rendering overwrites the carrier before deciding who owns it

**Confidence: high; real Agent serializer reproduced.** `DiskSerializer.store` (`fs_store/serializer/disk.py:203-219`) calls `_write_main` before `_commit_identity`; `_frontmatter` at 129-133 injects `obj.id`, and `_write_main` at 245 replaces the old header. The identity seam consequently sees the just-overwritten id and cannot preserve the previous valid carrier. This contradicts `DataSerializer.store`'s declared committed-identity contract (`serializer/protocol.py:31`) and the existing unowned-file test ([tests/unit/test_data_spec/test_asset_roundtrip.py:210](/Users/shlom/Documents/dev/flowpad-oss/tests/unit/test_data_spec/test_asset_roundtrip.py:210)).

**Isolated repro:** instantiate two real Agents with different valid v4 ids; call DiskSerializer.store for both at the same temp origin. The second store returns its own id and the file adopts it, despite already carrying the first id. Existing tests prove winner-preservation for an unowned `_Leaf`, and owned updating only for one Agent; they miss their intersection.

**Scope caution:** ordinary fresh `Entity.save()` has collision checks/path guards (`entity_model.py:2523-2538`, `2600-2631`), so this is **not** evidence that ordinary duplicate fresh creates freely overwrite one another. The gap is the serializer's own contract and direct storage/stale existing-entity or externally replaced-carrier updates, which bypass fresh-create guards. Entity.store and the fs-record materialization helper call this serializer directly.

**Smallest fix seam:** establish/validate the existing carrier under the same canonical-path transaction before rendering a replacement header. Either adopt the actual identity consistently into all persisted surfaces or reject a mismatched target before touching bytes. Never rewrite an existing identity just because an object proposed another one.

**Verification:** extend winner-preservation to owns_main_ref=True, force=True and a stale existing entity; body and header policy should be explicit, carrier identity unchanged unless a dedicated authorized identity operation exists.

## A4 — Optimization: parse each asset snapshot once through identity and materialization

**Confidence: high on repeated work; performance benefit not wall-clock benchmarked.** `DiskSerializer._read_main` (`disk.py:332-335`) independently reads frontmatter and body. `_load_typed` at 289 then calls `_read_identity`, rereading/parsing that same file. An instrumented real Agent load, wrapping Path.read_text only to count real reads, performed **three reads of agent.md**. Full extraction has already resolved identity before `spec_extractor` calls serializer.load (`serializer/record.py:44-49`), adding further repeat work; legacy-carrier fallback can add more.

This is also a robustness opportunity: independently read header, body and id can represent different revisions when a user edits during the load. A single immutable content snapshot eliminates that torn logical view without a persistent cache or stale-cache policy.

**Smallest seam:** add a frontmatter document snapshot/read_doc result (header/body/raw bytes/freshness) at the low-level parser; let identity and the spec extractor consume that snapshot and the already-resolved id. Keep type-owned carrier interpretation and layout behavior. Measure syscalls/read bytes, YAML parse count, indexing throughput and peak memory on representative markdown/skill trees. The measured serializer-only target is three reads to one, not a claimed 3x end-to-end speedup.

## A5 — Code reduction: consolidate byte writers and declarative slots, preserving boundaries

**Confidence: high on duplication; proposals, not defects.**

1. `capsules/atomic.py:22` and `fs_store/indexer/_frontmatter.py:192` implement almost the same skip-identical/tempfile/flush/fsync/preserve-mode/os.replace/cleanup sequence. FSRef.write_md, FrontMatterFsRef.write_frontmatter and JSONFsRef._flush separately retain direct truncating writes. One neutral bytes/text write substrate below both capsules and indexer would remove duplicate durability logic and make guarantees consistent. Preserve capsule-lock transactions separately; atomic replacement alone does not fix A1. Potential deletion is tens of lines, not thousands; durability consistency is the larger gain.
2. `schema/type_info/__init__.py:39-183` repeats the declarative slots also authored on `TypeInfo` (`schema_registry.py:198-395`). Conversion is already generic, but a field must still be declared/defaulted/documented twice; register merge semantics are hand-maintained. Consider one shared immutable declaration shape and a runtime registry wrapper with explicit merge rules. This could remove a substantial repeated declaration block; measure actual eliminated lines during a focused refactor. Preserve TypeMetadata authoring ergonomics, runtime TypeInfo lookup, central EntityType, spec/row validation and late entity binding. Do not collapse asset/record/entity responsibilities into one new god-object.
3. `JSONFsRef` retains cached write-through `{"data": ...}` and references the deleted `_save_split_format` (`json_ref.py:17`). The reviewed backend search found no ordinary production constructor use beyond FSRef.from_dict reconstruction. Audit full API/SDK compatibility before retaining or deprecating it; it must not become a second metadata-shadow persistence protocol.

## Documentation drift

- [docs/data-management/data-source-asset.md:264](/Users/shlom/Documents/dev/flowpad-oss/docs/data-management/data-source-asset.md:264) says data_source_spec ids derive from folder paths and are identical on every machine. Current `schema/type_info/data_source_spec_type_info.py` and `indexer/functions/data_source_spec.py:data_source_spec_identity_key` deliberately derive from manifest **name**, fixing install-path duplicates (FLOWPAD-2070).
- [docs/data-management/compute-node-fs-records.md:237](/Users/shlom/Documents/dev/flowpad-oss/docs/data-management/compute-node-fs-records.md:237) and `:657` still say sync failure is debug-only. Current `_index_sync_warning` (`builtin/faas/fs_records_actions.py:2162`) logs WARNING and returns an `index_sync_failed` warning in the successful-write envelope.
- `docs/fs-ref.md:16-17` call exported classes FrontmatterRef/BinaryRef; current exports use FrontMatterFsRef/BinaryFsRef. The larger drift is the normative universal read-only guarantee vs A2.

## Sound boundaries to preserve

The single filesystem identity seam, valid v4/v5 adoption, read-only derived fallback, one concrete FSRecord, TypeInfo-driven placement/serializers, registered DataSpec field kinds, parser-supplied resolved id, create-target collision guard, capsule package's independence from Entity/DB, and DB-shadow/source-write separation are useful existing simplifications. The review's priority is to complete their contracts, then remove duplicate implementations. No UUID scheme change, timeout increase, parallel persistence protocol, or per-type branching is required.

## Verification performed and limits

Read-only source inspection plus one isolated Python process using temporary FLOW_HOME/records/database paths; no actual database opened, no network and no live instances called. Reproduced concurrent identity race, FSRef read-only/provenance loss, owned serializer identity overwrite and counted real serializer file reads. Scratch root: `/var/folders/t7/2q_q73bj7y740q9rd1j62tm40000gn/T/flowpad-asset-review-cd5xgydu`. The concurrency test's distinct-id counts are timing-sensitive observations; the underlying interleaving is deterministic from the unguarded implementation. No unit suite executed or modified and no claims of full E2E validation.
