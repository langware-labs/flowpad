---
id: 56fb0e59-2f93-57c1-bec9-49a18b3151c5
---

# Scan and Discovery

This document describes the discovery mechanisms used throughout `flow_sdk` to locate, load, and index records from disk. The current model is a single **DFS walker** — `FSIndexer` (`flow_sdk/fs_store/indexer/index_function.py`) — that starts from a small set of roots, fans out through transient *waypoint* types, and dispatches per-type parser slots (`from_disk_fn` / `gen_uuid_fn` / `asset_hash_fn`) declared in `flow_sdk/schema/type_info/<type>_info.py`. It also covers Claude/Codex session lookup helpers, `RecordQuery` filtering, the scan/index HTTP actions, and error-record handling.

> **Disk is the source of truth.** Records are scanned from disk; the Entity/DB layer is a queryable index that can be deleted and rebuilt from disk without data loss. See `docs/CLAUDE.md`.

> **Indexing is explicit-action only.** A scan or index pass runs only when something explicitly requests it: a user clicking "reindex" in the UI (`POST /fs-records/index`), a scan/resource action, or a narrow self-heal that fires *only* when the caller passes an explicit `?hint_path=` (`_try_self_heal_missing_entity`, `flow_sdk/server/routes/graph.py`). It is **never** triggered automatically from mount, navigation, focus, bootstrap, or an interval (see the no-auto-walk rule, `feedback_no_auto_indexing.md`). Read-only `index-status` is the only thing the bootstrap path touches.

---

## The Walk: `FSIndexer`

**Source:** `flow_sdk/fs_store/indexer/index_function.py`

`FSIndexer` is a depth-first walker over `FSRef` nodes. Each `FSRef` carries a `record_type` discriminator (a `RecordType` / `EntityType` value). The walker maintains a stack of nodes; for each node it looks up the **walker functions** registered against that node's type and runs them, each of which returns a list of child `FSRef`s that are pushed back onto the stack.

```python
class FSIndexer:
    def __init__(self, roots: list[FSRef] | None = None) -> None:
        self._roots = list(roots) if roots is not None else []
        self._functions: dict[RecordType, list[tuple[IndexerFunc, RecordType | None]]] = {}

    def add_function(self, record_type, fn, output_type=None) -> None: ...
    def add_root(self, node) -> None: ...

    async def scan(self, opts=None) -> list[FSRef]: ...   # discover refs only
    async def index(self, opts=None) -> IndexResult: ...  # discover + parse + persist
```

Two public coroutines:

| Method | Purpose |
|---|---|
| `scan(opts)` | DFS over the roots; returns the flat list of visited `FSRef`s. No parse, no DB. |
| `index(opts)` | Runs `scan()`, then for each visited ref whose type declares a `from_disk_fn`, parses it into `FSRecord`s and persists them (`rec.sync_to_db(...)`) plus an FTS upsert. Returns an `IndexResult`. |

`IndexerOptions` (frozen dataclass) controls a run: `limit`, `limit_per_type`, `include_temp`, `types` (index filter), `roots` (per-call root override), `force` (bypass skip-fresh), `gitignore`, `project_id`, `orphan_action`, `scope_filter`, and `on_progress`.

### Roots

**Source:** `flow_sdk/fs_store/indexer/roots.py`

`default_roots()` returns up to three canonical roots plus any env-supplied extras:

| Root | `record_type` | Path | Scope |
|---|---|---|---|
| User home | `USER_HOME_FOLDER` | `InstanceSettings.user_home` (`~`; sandboxed in test mode) | `user` |
| Project cwd | `CWD_ROOT` | `Path.cwd()` — **only** when cwd is not the user's home dir | `project` |
| System root | `SYSTEM_ROOT` | `flowpad_assistant_project_root()` (if it exists) | `system` |

`CWD_ROOT` is deliberately skipped when `cwd == user_home` (the desktop app can launch the backend with `cwd=$HOME`): treating `$HOME` as a project root would make `project_folder_walker_fn` recurse the entire home tree and trip macOS TCC prompts. Env vars `FLOWPAD_DOC_DIRS` / `FLOWPAD_PLAN_DIRS` / `FLOWPAD_SKILL_DIRS` / `FLOWPAD_AGENT_DIRS` / `FLOWPAD_WORKFLOW_DIRS` add extra roots, tagged `CWD_ROOT` with `scope="user"`.

`classify_path(path)` is the inverse: it classifies a path back into `"system"` / `"user"` / `"project"` / `None`, used by HTTP create handlers to stamp scope at create time so POST-created records match indexer-discovered ones.

### Transient waypoint types

**Source:** `flow_sdk/schema/types.py` (lines ~104–109)

These types are **fan-out scaffolding** — they are never persisted as records. They exist only so the walker can reach indexable children:

```python
USER_HOME_FOLDER = "user_home_folder"
REAL_PROJECT_CWD = "real_project_cwd"
SYSTEM_ROOT = "system_root"
CWD_ROOT = "cwd_root"
FOLDER = "folder"
```

`PROJECT` (`~/.claude/projects/<encoded>` dirs) and `REAL_PROJECT_CWD` (the decoded real cwd) are *also* expansion nodes — they materialize as records (PROJECT) and/or fan out to children. In `index_function.py`, the set `_PROGRESS_HIDDEN_TYPES = {USER_HOME_FOLDER, SYSTEM_ROOT, REAL_PROJECT_CWD, CWD_ROOT, PROJECT, FOLDER}` filters these out of the progress table so the user sees only types they recognize (presentation-only; per-type accumulators still include them).

### Walker registration graph

**Source:** `flow_sdk/fs_store/indexer/builtin.py` (`build_default_indexer()`)

Walker functions live in `flow_sdk/fs_store/indexer/functions/*.py` and are wired to input types in `build_default_indexer()`. Each `add_function(input_type, fn, output_type)` registers an edge `input_type → output_type`. Examples (abridged):

```python
# USER_HOME_FOLDER expanders
idx.add_function(RecordType.USER_HOME_FOLDER, claude_projects_fn, RecordType.PROJECT)
idx.add_function(RecordType.USER_HOME_FOLDER, skill_fn,           RecordType.SKILL)
idx.add_function(RecordType.USER_HOME_FOLDER, claude_hook_files_fn, RecordType.CLAUDE_HOOK_SOURCE)
...
# PROJECT (encoded ~/.claude/projects/<dir>) expanders
idx.add_function(RecordType.PROJECT, claude_sessions_fn, RecordType.CLAUDE_SESSION)
idx.add_function(RecordType.PROJECT, claude_memory_fn,   RecordType.CLAUDE_MEMORY)
# REAL_PROJECT_CWD expanders
idx.add_function(RecordType.REAL_PROJECT_CWD, project_folder_walker_fn, RecordType.FOLDER)
idx.add_function(RecordType.REAL_PROJECT_CWD, spec_project_fn,          RecordType.SPEC)
...
# FOLDER (transient scaffold) expanders
idx.add_function(RecordType.FOLDER, markdown_in_folder_fn,    RecordType.MARKDOWN)
idx.add_function(RecordType.FOLDER, workflow_frontmatter_fn,  RecordType.WORKFLOW)
# Stage-2 into-file walks
idx.add_function(RecordType.CLAUDE_HOOK_SOURCE, hooks_in_settings_fn,  RecordType.CLAUDE_HOOK)
idx.add_function(RecordType.MCP_SERVER_SOURCE,  mcp_servers_in_file_fn, RecordType.MCP_SERVER)
```

Notable structural facts:

- **Two-stage into-file walks.** Hooks and MCP servers are discovered in two steps: `<root> → *_SOURCE` (one FSRef per `settings.json` / `.mcp.json`-like file), then `*_SOURCE → leaf` (one FSRef per entry, each carrying a distinct RFC-6901 `json_path` so fragment records sharing one file are not collapsed by the DFS dedup key `(path, record_type, json_path)`).
- **`real_project_cwd_fn` is intentionally NOT registered** on `USER_HOME_FOLDER`. Project-cwd fan-out used to be implicit (any user-home scan silently walked every project tree). Project-cwd roots are now contributed explicitly by the scope filter via `_resolve_scoped_roots` — callers wanting all projects pass a `ScopeFilter` from `get_all_scope_filter()`.
- **Codex projects** are consolidated into `RecordType.PROJECT` (`codex_projects_fn` is annotated `PROJECT`); `CODEX_PROJECT` is a deprecated alias.

### Type-gating the dispatch

When `opts.types` is set, `scan()` computes the reverse-reachability closure (`_compute_needed_output_types`, BFS over reversed edges) of output types whose walk transitively produces a requested type. A walker function whose `output_type` isn't in that closure is skipped — e.g. a `?type=skill` scan skips `project_folder_walker_fn` (FOLDER) since no chain leads from FOLDER to SKILL. Functions registered with `output_type=None` disable the skip (legacy safe default).

### Chunked / threaded DFS

Walkers are typically synchronous file I/O. `scan()` runs them in chunks of `_SCAN_CHUNK_NODES = 256` node-visits per `asyncio.to_thread` round-trip, yielding the event loop between chunks so progress emits and concurrent requests stay responsive. Async walkers (rare) are detected via `_is_async_walker` and awaited on the main loop.

---

## Per-type Dispatch Slots: `from_disk_fn` / `gen_uuid_fn` / `asset_hash_fn`

**Source:** `flow_sdk/schema/type_info/__init__.py` (`TypeMetadata`), registered into `SchemaRegistry` (`flow_sdk/fs_store/schema_registry.py`, `TypeInfo`).

Per-type metadata is authored as a `TypeMetadata` instance in `flow_sdk/schema/type_info/<type>_info.py`. `register_all()` imports every sibling module and registers each into `SchemaRegistry`. (Per `project_typeinfo_registration_chokepoint.md`, `build_default_indexer()` is the chokepoint that guarantees the registry is fully populated — it imports `indexer.registrations`, which calls `register_all()`.)

The dispatch callables:

| Slot | Signature | Role |
|---|---|---|
| `from_disk_fn` | `(FSRef) -> list[FSRecord]` (sync or async) | Parse one discovered ref into one or more records. `index()` only parses refs whose type declares this (`_has_dispatch`). |
| `gen_uuid_fn` | `(FSRef) -> str` | Mint-on-first-encounter id: idempotent if the file already carries an id (e.g. frontmatter), else writes the derived id back so future scans are rename-stable. Falls back to a `mint_uuid(path)` uuid5 when absent. |
| `asset_hash_fn` | `(...) -> str` | Content hash for the type's primary asset (used by skip-fresh / sentinel logic). |
| `post_sync_fn` | hook | Post-sync side effects. |
| `default_body_fn` | hook | Default-body writer for `FSRecord.upsert_main_ref` on create. |

Example (`flow_sdk/schema/type_info/skill_type_info.py`):

```python
SKILL = TypeMetadata(
    type=EntityType.SKILL,
    icon="Sparkles", browseable=True, creatable=True,
    indexed_by_default=True, api_visible=True,
    index_fields=["description"],
    main_subdir=".claude/skills", main_layout="folder",
    from_disk_fn=extract_skill,
    gen_uuid_fn=skill_gen_id,
    asset_hash_fn=skill_asset_hash,
)
```

### `index()` per-record loop

For each visited ref of a type that has a `from_disk_fn`:

1. **Mint id** via `gen_uuid_fn` (or default `mint_uuid(path)`), record it in `seen_ids` *before* any skip/index decision (so a fresh-skip isn't later misclassified as an orphan).
2. **Skip-fresh** (unless `opts.force`): a probe `FSRecord` reads its own on-disk `.hash` sentinel; if `not index_required`, increment `skipped` and continue. This is pure on-disk equality — no parse, no DB read.
3. **Parse + persist**: call `from_disk_fn(ref)` (awaited or via `to_thread`), stamp walk-time `scope`/`project_id` from the FSRef parent-chain onto each record, `await rec.sync_to_db(fts_batch=..., notify=False)`, then `probe.write_hash()` on success (a failed parse stays `index_required` for retry).

The whole loop runs inside **one DB session** but commits in **bounded batches** (`_INDEX_COMMIT_BATCH = 50`). The engine issues `BEGIN IMMEDIATE` per transaction; a single session spanning the whole scan would hold the SQLite writer lock for seconds/minutes and starve concurrent requests (`database is locked`). Per-batch commits release the lock between batches. This is a contention fix, not a `busy_timeout`/retry change. (See `project_indexer_db_lock_contention.md`.)

### Orphan handling

After the index loop, orphans are detected **entirely on-disk** (zero DB reads):

```
orphan_ids = (records_dir_ids | db_row_ids) - seen_ids
```

A record is an orphan iff its Layer-1 source is gone. `OrphanAction` controls the response:

| Action | Effect |
|---|---|
| `INDEX` (default) | Count only; remove nothing (historical no-op). |
| `IGNORE` | Remove the DB row + FTS entry; keep the on-disk record dir (tombstone). |
| `DELETE` | Remove DB row + FTS entry **and** `rmtree` the record dir. |

Orphan detection is constrained to `INDEXABLE_TYPES` (`_resolve_orphan_filter_types`) so runtime-only types with DB rows but no walker (e.g. `conversation`, `flow_message`, `annotation`, `compute_node`, `invitation`) are never flagged as orphan en masse. A destructive action on a *narrowed* walk (`opts.roots` set) without a `scope_filter` is refused and falls back to `INDEX` — cross-scope references would otherwise be misclassified.

---

## Claude / Codex Session Lookup

**Source:** `flow_sdk/fs_store/indexer/functions/claude_sessions.py` (+ `codex_sessions.py`, `_claude_session_stats.py`)

Claude sessions live at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (the encoded dir name is the absolute cwd with `/` replaced by `-`). During a full walk they are reached via `claude_sessions_fn` registered on `PROJECT`.

Direct lookup helpers (used by scan actions and session resolution):

| Helper | Behavior |
|---|---|
| `get_claude_session(uid, project=None)` | O(1) fast path when `project` is given (`projects/<encoded>/<uid>.jsonl`); else scans project dirs until first match. Returns an `FSRecord` or `None`. |
| `discover_claude_session_paths_iter(limit=None)` | Yields session JSONL paths under `~/.claude/projects/<encoded>/*.jsonl`. |
| `extract_claude_session(ref)` / `extract_claude_session_from_path(path)` | The `from_disk_fn` parser — builds the session `FSRecord`. |
| `claude_session_is_active(rec)` / `claude_session_status(rec)` | mtime-based activeness / `WorkerStatus` derivation. |

`get_codex_session(uid)` is the Codex counterpart. `scan_actions.py`'s `_resolve_session_record(session_id, hint)` tries Claude first then Codex (or the hinted backend) via these helpers.

Per-session stats (`_claude_session_stats.py::_parse_jsonl_stats`) parse the JSONL to count user/assistant messages, estimate cost, and read mtime for `modified_at`.

> **Schema drift caveat:** Claude transcript event schemas change between CLI versions. When sessions render as raw UUIDs instead of titles, check for new event types in the session parsers (see `project_claude_transcript_format_drift.md`).

---

## `RecordQuery` — Filtering, Sorting, and Pagination

**Source:** `flow_sdk/fs_store/record_query.py`

`RecordQuery` is a dataclass encapsulating filter criteria, sort order, and pagination. It operates on any iterable of `Record`/`FSRecord` objects.

### Fields

All filter fields default to `None` ("no constraint"); active constraints are AND-ed.

| Field | Type | Description |
|---|---|---|
| `ids` | `list[str] \| None` | Include only records whose `id` is in this list |
| `types` | `list[str] \| None` | Include only records whose `type` is in this list |
| `status` | `str \| list[str] \| None` | Match record status; string = exact, list = any-of |
| `created_after` / `created_before` | `datetime \| None` | `created_at` range bounds |
| `modified_after` / `modified_before` | `datetime \| None` | `modified_at` range bounds |
| `parent_id` | `str \| None` | Match `parent_ref.id` |
| `child_filter` | `RecordQuery \| None` | Declared for recursive composition (not evaluated by `matches` directly) |
| `predicate` | `Callable[[Record], bool] \| None` | Arbitrary caller-supplied logic |
| `field_predicates` | `dict[str, Any] \| None` | Match arbitrary record attrs by exact equality |
| `scope` | `Scope \| None` | Match `record.scope` (value-coerced) |
| `sort_by` | `str \| None` | Attribute to sort by (`"created_at"`, `"modified_at"`, `"name"`, …) |
| `sort_desc` | `bool` (default `True`) | Descending when `True` |
| `offset` | `int` (default `0`) | Records to skip after filter+sort |
| `limit` | `int \| None` | Max records returned |

### `matches()` and `apply()`

`matches(record)` runs each active constraint:

- `ids` compares against `record.id`.
- `status` coerces `record.status` to a string (`""` if unset, so `status=""` matches statusless records).
- Date constraints fail for `created_at`/`modified_at = None` (treated as non-matching, not "unknown").
- `parent_id` requires a non-`None` `parent_ref` whose `.id` matches.
- `scope` is value-coerced on both sides; `field_predicates` checks attr equality.

`apply(records)` filters via `matches`, sorts (records whose sort attr is `None` get key `(1, "")`, pushing them to the end regardless of direction), then paginates `offset` → `limit`. `to_provider_params()` serializes the query into a pushdown-safe dict for external providers.

### Usage Example

```python
from datetime import datetime, timezone
from flow_sdk.fs_store.record_query import RecordQuery

q = RecordQuery(
    types=["claude_session"],
    modified_after=datetime(2026, 1, 1, tzinfo=timezone.utc),
    sort_by="modified_at",
    sort_desc=True,
    limit=20,
)
recent = q.apply(all_sessions)
```

---

## `SchemaRegistry` — Type Registry + Scan/Index Logging

**Source:** `flow_sdk/fs_store/schema_registry.py`

`SchemaRegistry` is the single source of truth for types: every type name registers there (via `TypeMetadata.register()` / `Entity.__init_subclass__`). It does **not** orchestrate the walk anymore — there is no `SchemaRegistry.discover()` / `incremental()` / `rebuild_index()`. The walk is `FSIndexer`. The registry's surviving roles:

- **Type metadata lookup:** `get(type)`, `get_icon`, `is_browseable`, `is_creatable`, `is_api_visible`, `is_indexed_by_default`, `get_entity_cls`, `get_subtypes`, etc.
- **Default index types:** `get_default_index_types()` returns `_BUILTIN_DEFAULT_TYPES`:

  ```python
  _BUILTIN_DEFAULT_TYPES = [
      SKILL, AGENT, TASK, MARKDOWN, PLAN,
      CLAUDE_MD, CLAUDE_MEMORY, CLAUDE_RULES, CLAUDE_HOOK, COMMAND,
  ]
  ```

  This list must overlap with `INDEXABLE_TYPES` (`flow_sdk/fs_store/indexer/builtin.py`) — the indexer can't walk a type with no registered walker. Runtime-only types (`BOOKMARK`, `ANNOTATION`, `AGENTIC_PROCESS`, `RECORD_ERROR`, `CLAUDE_ERROR`) are intentionally excluded.
- **Scan/index logging:** `append_scan(...)`, `append_index(...)`, `get_last_scan_at(type)`, `get_last_index_at(type)`.
- **Index status:** `await get_index_status(...)` → `IndexStatus` (`never_indexed`, `last_indexed_at`, `stale`, `per_type` with entity counts).
- **Index clearing:** `await clear_index(types)` deletes FTS entries + entities for the given types (or all).

---

## When Does Indexing Run

There is **no filesystem-watcher-triggered indexer walk** — a file changing on disk does not start a scan. Indexing runs only on these paths:

| Trigger | What runs | Source |
|---|---|---|
| **Explicit request** (UI refresh button, `flow record index`, API call) | `FSIndexer.index()` via `POST /fs-records/index` and the sibling scan endpoints below | `flow_sdk/builtin/faas/fs_records_actions.py` |
| **Server startup** (once per process, detached background task) | System content only: system projects, their markdown docs, and the SDK-shipped assistant assets (hash-gated, skipped if another index is running). Never inline in the bootstrap request. | `flow_sdk/server/app.py` (`_start_system_content_index`) → `flow_sdk/server/routes/bootstrap.py` (`index_system_content`) |
| **GET-time lazy refresh** (per entity) | If the record's `index_required` says the source changed, re-run `sync_to_db()` + stamp the sentinel — one record, no walk | `Entity.check_and_refresh_record()` (`flow_sdk/core/entity/entity_model.py`) |
| **404 self-heal** (dock loader) | A single-file, single-type forced index when a navigation carries `?hint_path=` for an entity the DB doesn't have | `_try_self_heal_missing_entity` (`flow_sdk/app/actions/graph.py`) → `flow_sdk/fs_store/transcript_indexer/handlers/single_file_indexers.py` |
| **Resource-browser scans** | Read-only `FSIndexer.scan()` projections (no DB writes) | `flow_sdk/builtin/faas/scan_indexer.py` |

The deliberate absence of auto-indexing is a product decision: walks are user-visible work (progress pill) and only start on an explicit click or the narrow startup/system scope above.

## Scan & Index API Endpoints

### fs-records actions (ComputeNode)

**Source:** `flow_sdk/builtin/faas/fs_records_actions.py` (`FsRecordsActionsMixin`)

| Method | Endpoint | Handler | Description |
|---|---|---|---|
| `GET` | `/fs-records/scan[?type=X]` | `_handle_fs_records_scan` | `FSIndexer.scan()`; aggregate stats or per-type list |
| `POST` | `/fs-records/index[?type=X&rebuild=&force=&user=&projects=&orphan_action=]` | `_handle_fs_records_index` | `FSIndexer.index()`; index all / one type / rebuild / scoped |
| `GET` | `/fs-records/index-status[?user=&projects=]` | `_handle_fs_records_index_status` | Read-only status (no walk) |
| `DELETE` | `/fs-records/index` | `_handle_fs_records_index_clear` | Clear the index |
| `POST` | `/fs-records/{type}/discover?path=<P>` | `_handle_fs_records_discover_by_path` | Single-path index for one type |

Both scan and index emit `progress_report` FlowData events via the shared indexer's `on_progress` callback. Scope is taken from the canonical wire format `?user=true&projects=A,B`; absent params resolve to an explicit "everything known" filter via `get_all_scope_filter()`. The legacy `?project_id=<id>` shim is ignored (logged as a warning).

### Search

**Source:** `flow_sdk/server/routes/search.py`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/search?q=...&limit=...&record_type=...&status=...` | FTS5 full-text search; empty `q` browses all. Returns `indexer_ready` flag. |

> This module is **search-only**. The old `POST /api/v1/search/reindex[/{type}]` endpoints no longer exist — reindexing is `POST /fs-records/index`.

### Bootstrap `scan_info`

`GET /api/v1/graph/bootstrap` includes a `scan_info` field from `get_scan_info()` (`flow_sdk/system_tools.py`), which reads `SchemaRegistry.get_index_status()` and sums `per_type.entity_count`:

```json
{
  "total_indexed": 0,
  "last_indexed_at": "2026-03-10T14:23:00+00:00",
  "never_indexed": false,
  "stale": true
}
```

### Scan resource actions

**Source:** `flow_sdk/builtin/faas/scan_actions.py` (`ScanActionsMixin`) + `scan_indexer.py`

`scan-resources`, `get-resource-summary`, `scan-item`, `scan-project`, and `list-projects` all route through `scan_indexer.*`, which drive the shared `FSIndexer` against scoped roots resolved by `_scan_scoped_roots()` (`get_all_scope_filter()` → `_resolve_scoped_roots`). Session-process actions (`scan-create-process`, `upsert-session-process`, `get-by-worker-id`, `find-session`) resolve sessions on disk via `_resolve_session_record` and create/heal `AgenticProcess` rows.

---

## Error Record Handling

### RecordError / ClaudeErrorRecord

**Source:** `flow_sdk/fs_store/operations/claude_error.py`, `flow_sdk/fs_store/operations/claude_debug_log.py`

Error records (`record_error`, `claude_error`) are registered via `flow_sdk/fs_store/indexer/registrations.py` (operations modules) but have **no FSIndexer walker** — they are runtime-only and excluded from `_BUILTIN_DEFAULT_TYPES` / orphan detection. `claude_error` records carry fingerprint-based dedup (SHA256 of normalized error text) and triage statuses (`open`, `ignored`, `ignored_until`, `task_created`), parsing `~/.claude/debug/*.txt`. Their cleanup is wired into `SchemaRegistry.clear_index()`.

---

## Performance Summary

| Operation | Complexity | Notes |
|---|---|---|
| `FSIndexer.scan()` | O(V) | V = nodes visited across the DFS from the roots |
| `FSIndexer.index(types=T)` | O(V + R) | Type-gating skips unreachable walkers; R = refs parsed (skip-fresh avoids re-parse of unchanged) |
| `get_claude_session(uid, project=...)` | O(L) | One JSONL read, L = lines |
| `get_claude_session(uid)` (no project) | O(P) until match | P = project dirs scanned |
| `RecordQuery.apply()` | O(N log N) | Dominated by the sort |
| `SchemaRegistry.get_index_status()` | O(T) | Reads per-type log timestamps; T = types |

---

## Known Issues

### Long index pass vs SQLite writer lock (mitigated)

`index()` holds one DB session but commits in bounded batches of 50 (`_INDEX_COMMIT_BATCH`) precisely because the engine's per-transaction `BEGIN IMMEDIATE` would otherwise hold the writer lock for the whole scan and starve concurrent requests with `database is locked`. The write path is fixed; the read-path `BEGIN IMMEDIATE` contention noted in `project_indexer_db_lock_contention.md` (issue #2) is deferred — concurrent reads still funnel through `BEGIN IMMEDIATE` and can contend during a heavy index.

### Destructive orphan action on a narrowed walk

A non-`INDEX` `orphan_action` combined with custom `roots` and no `scope_filter` would misclassify cross-scope-referenced records as orphans and wipe them. The code refuses this (falls back to `INDEX` + warning), but the safety relies on callers either widening the walk to global (`roots=None`) or supplying a `scope_filter`. A caller that bypasses the HTTP wrapper and constructs `IndexerOptions` directly must respect this contract.

### Self-heal indexing depends on an explicit path hint

`_try_self_heal_missing_entity` (graph route) only runs a single-file index when the caller passes `?hint_path=`. A 404 on an entity whose source exists on disk but was never indexed will not self-heal unless the caller supplies the path — consistent with the no-auto-walk rule, but a discoverability gap for callers unaware of the hint parameter.
