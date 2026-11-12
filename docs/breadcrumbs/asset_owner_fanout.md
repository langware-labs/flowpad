---
id: 08e016ad-91f5-4bdb-8394-b269b88788f1
title: Who owns a path is one query, not one per asset-owning type
tags:
- breadcrumb.test.asset_owner_fanout.rules
description: The asset-dependencies doc page passed its 15 s budget only on fast hosts.
  Each path-owner lookup asked all ~46 asset-owning types one query each (~0.35 s
  a lookup); one probe query naming the holding types cut the page by ~3.5 s.
---
# Who owns a path is one query, not one per asset-owning type

> Ground truth. Proven by RCA on 2026-11-12. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.asset_owner_fanout.rules
sites:
  - rel_path: "tests/unit/test_asset_dependencies_snippets.py"
    line: 87
    note: "FAILING? never raise the 15 s cap - read this tag's rules; count path-owner queries first"
  - rel_path: "tests/unit/test_folder_source/test_asset_owner_lookup_queries.py"
    line: 40
    note: "FAILING? a path-owner lookup must be one probe query, not one per type - read this tag's rules"
```

## Expected behavior

`docs/snippets/asset-dependencies.md` runs end to end (`test_every_fence_runs_as_written`) inside its
15 s cap on a slow Linux host too (AMD EPYC VM: 10.4-12.6 s for the test body). Asking "which entity
owns this path" costs one probe statement, plus one query per type that actually holds a match.

## Internals

| step | where |
| --- | --- |
| Cross-type lookup by a field (`asset_ref`, `origin_id`) | `Entity.first_across_asset_owners` (`flow_sdk/core/entity/entity_model.py`) |
| Files inside a folder-backed asset | `Entity._get_by_containing_folder` (same file) |
| The probe: which candidate types hold a matching row | `Entity._types_holding` → `SQLiteDBDriver.types_holding` (`flow_sdk/db/drivers/sqlite/sqlite_driver.py`): `SELECT DISTINCT type FROM entities WHERE type IN (...) AND <match>` |
| The driver default (cannot tell → `None`) | `DBDriver.types_holding` (`flow_sdk/db/drivers/db_driver.py`) |
| Callers per synced file | `ingest/sync.py:_place` → `reflect.reflect_refs` → `origin_identity.resolve`, `get_by_asset_ref`, `reindex.reindex_paths` |

## Invariants

* **Never raise the 15 s cap.** A failure means a lookup grew; count the SELECTs a lookup issues
  (`test_asset_owner_lookup_queries.py` does) before anything else.
* `Entity.asset_owner_classes()` is ~46 types. Without the probe every lookup is 46 `get_one`s,
  concurrently, and each builds its own query and session: ~0.35 s a lookup on the slow host.
* The probe keeps the old semantics: only types the probe names are asked, in candidate order, and
  `strict` still raises on a failed per-type read. A probe that cannot run (match not fully SQL, a
  driver without it, a failed read) falls back to asking every type.
* The first read that needs an entity class imports ~500 modules (1-2 s,
  `SchemaRegistry._ensure_entities_loaded`). The doc-page test pays it at collection, so its budget
  measures the page.

## Failure modes

* **Page over 15 s, fence #4 (three Drive sources) slowest.** Measured 2026-11-12: lookups 3.15 s →
  0.16 s with the probe; `_get_by_containing_folder` 0.61 s → 0.05 s. Fix off: 14.1-14.3 s body (1 of
  2 timed out); on: 10.4-12.6 s (3 of 3 passed).
* **What remains** is spread: `Project.add_dependency` (~0.6 s each, `dependency_project` /
  `_mount_owners` / `_enclosing_owners` called ~80 times), project and source saves (~0.2-0.3 s each).
  No SQL storm: the page issues ~1,000 statements in all.
