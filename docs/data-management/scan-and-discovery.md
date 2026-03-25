# Scan and Discovery

This document describes the discovery mechanisms used throughout `flow_sdk` to locate, load, and filter records from disk. It covers the standard directory-scan (`Record.discover`), the O(1) single-record lookup (`Record.discover_one`), the two Claude session discovery modes, `SourceFileRecordList` extraction from config files, and `RecordQuery` filtering.

---

## Standard Discovery: `Record.discover()`

**Source:** `flow_sdk/fs_store/record.py`

### Storage Layout

All owned records are stored under a single root directory:

```
~/.flow/records/<type>/<type>-@<uid>/
```

The default root (`_DEFAULT_RECORDS_ROOT`) is `Path.home() / ".flow" / "records"`. It can be overridden at runtime via `set_default_records_root(path)`, which is used in tests to redirect writes to a temporary location.

### Directory Structure and Naming Convention

Each record occupies a folder whose name follows the stem pattern `<type>-@<uid>`. The separator is `-@`. For example, a session record with uid `abc123` of type `claude_session` lives at:

```
~/.flow/records/claude_session/claude_session-@abc123/
```

The folder contains the record metadata file at one of two locations:

| Convention | Path within folder | When used |
|---|---|---|
| New (preferred) | `.flow_record/record.json` | All records created after the convention change |
| Legacy | `record.json` | Records created before the `.flow_record/` subdirectory was introduced |

### `resolve_record_json(folder)`

This function resolves which path within a folder holds the record JSON. It is called by both `discover` and `discover_one` before loading:

```python
def resolve_record_json(folder: Path) -> Path:
    new = folder / ".flow_record" / "record.json"
    if new.exists():
        return new
    old = folder / "record.json"
    if old.exists():
        return old
    return new  # default to new convention for creation
```

The lookup order is:

1. Check `folder/.flow_record/record.json` — if present, use it.
2. Fall back to `folder/record.json` — if present, use it (legacy).
3. If neither exists, return the new-convention path so callers writing new records always create at the canonical location.

### `discover()` — O(N) Directory Scan

```python
@classmethod
def discover(cls: type[T], scope: Scope | None = None, **kwargs: Any) -> list[T]:
    record_type = getattr(cls, "_record_type", "") or cls().type
    if not record_type:
        return []

    records_root = get_default_records_root()
    type_dir = records_root / record_type
    if not type_dir.is_dir():
        return []

    results: list[T] = []
    for entry in sorted(type_dir.iterdir()):
        if not entry.is_dir() or _NAME_SEP not in entry.name:
            continue
        rj = resolve_record_json(entry)
        if not rj.exists():
            continue
        try:
            rec = cls.init_record(rj)
            rec.path = str(entry)
            results.append(rec)
        except (json.JSONDecodeError, OSError):
            continue
    return results
```

The algorithm:

1. Determine `record_type` from the class's `_record_type` ClassVar.
2. Compute `type_dir = records_root / record_type`. Return `[]` if it does not exist.
3. Iterate all entries in `type_dir` in sorted order (alphabetical by stem).
4. Skip entries that are not directories or that do not contain the `-@` separator in their name.
5. Call `resolve_record_json(entry)` to find the metadata file (new or legacy convention).
6. Skip entries where that file does not exist.
7. Call `cls.init_record(rj)` to load and deserialize the record. Set `rec.path = str(entry)`.
8. Skip entries that raise `json.JSONDecodeError` or `OSError` (silently continues). **Note:** `ValueError` (raised by `read_record()` when a record file is empty) is not caught and will abort the entire scan. Empty `record.json` files are a known risk after crash-interrupted writes.

The `scope` parameter is accepted but not used by the default implementation. Subclasses may use it to filter records by scope after loading.

**Performance:** O(N) in the number of subdirectories under the type directory. Each iteration does one `stat` call (for `is_dir()`), one `resolve_record_json` call (one or two `exists()` checks), and one file read for the JSON. For large collections this adds up linearly.

---

## O(1) Single-Record Lookup: `Record.discover_one()`

```python
@classmethod
def discover_one(cls: type[T], uid: str, scope: Scope | None = None, **kwargs: Any) -> T | None:
    record_type = getattr(cls, "_record_type", "") or cls().type
    if not record_type:
        return None

    records_root = get_default_records_root()
    stem = record_stem(record_type, uid)
    folder = records_root / record_type / stem
    if not folder.is_dir():
        return None

    rj = resolve_record_json(folder)
    if not rj.exists():
        return None

    try:
        rec = cls.init_record(rj)
        rec.path = str(folder)
        return rec
    except (json.JSONDecodeError, OSError):
        return None
```

The algorithm:

1. Construct the canonical stem: `<type>-@<uid>`.
2. Build the expected folder path: `records_root / record_type / stem`.
3. If the folder does not exist, return `None` immediately (no scan required).
4. Call `resolve_record_json(folder)` and check existence.
5. Load and return the record.

**Performance:** O(1). No directory iteration. The total number of records in the type directory does not affect the lookup time. Cost is two filesystem `stat` or `exists` calls plus one file read.

---

## Subclass Discovery Overrides

Source-file-backed records store their data in files not owned by the `~/.flow/records/` layout. These subclasses override `discover` and/or `discover_one` to read from their actual sources.

### `ClaudeSessionFsRecord.discover()`

**Source:** `flow_sdk/fs_records/claude/claude_session.py`

Overrides the standard scan to read from Claude Code's transcript directory:

```python
@classmethod
def discover(cls, scope=None, **kwargs) -> list[ClaudeSessionFsRecord]:
    projects_dir = Path.home() / ".claude" / "projects"
    if not projects_dir.is_dir():
        return []
    results: list[ClaudeSessionFsRecord] = []
    for project_dir in sorted(projects_dir.iterdir()):
        if not project_dir.is_dir():
            continue
        for jsonl_file in sorted(project_dir.glob("*.jsonl")):
            try:
                rec = cls.from_jsonl(jsonl_file)
                results.append(rec)
            except (json.JSONDecodeError, OSError):
                continue
    return results
```

This iterates every project subdirectory under `~/.claude/projects/` and loads every `.jsonl` file it finds. Unlike the standard scan, it calls `from_jsonl()` instead of `init_record()`, reading and parsing the full JSONL transcript to produce aggregated statistics.

### `ClaudeSessionFsRecord.discover_one()`

The session subclass provides two resolution strategies:

```python
@classmethod
def discover_one(cls, uid: str, scope=None, **kwargs) -> ClaudeSessionFsRecord | None:
    projects_dir = Path.home() / ".claude" / "projects"
    if not projects_dir.is_dir():
        return None
    fname = f"{uid}.jsonl"

    # Fast path: caller knows the project directory
    project_path = kwargs.get("project")
    if project_path:
        encoded = str(project_path).replace("/", "-")
        candidate = projects_dir / encoded / fname
        if candidate.exists():
            try:
                return cls.from_jsonl(candidate)
            except (json.JSONDecodeError, OSError):
                return None

    # Slow path: scan all project directories
    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue
        candidate = project_dir / fname
        if candidate.exists():
            try:
                return cls.from_jsonl(candidate)
            except (json.JSONDecodeError, OSError):
                return None
    return None
```

| Mode | Trigger | Path constructed | Performance |
|---|---|---|---|
| Fast path | `discover_one(uid, project="/abs/path")` | `projects/<encoded>/<uid>.jsonl` | O(1) |
| Slow path | No `project` kwarg | Iterates project dirs until first filename match | O(P) where P is number of projects |

**Slow-path caveat:** The slow path returns `None` immediately upon the first `json.JSONDecodeError` or `OSError` encountered on a candidate file — it does not continue to the next project directory. If the same session filename exists in multiple project directories and the first match is corrupt, the method returns `None` even though a valid copy exists elsewhere.

The encoding used in the fast path replaces `/` with `-` to match how Claude Code names project directories.

---

## Active Session Discovery

The active session subsystem uses mtime-based staleness checks to determine whether a Claude Code process is currently running, without touching the process table.

### `ClaudeActiveSessionFsRecord.from_jsonl()`

**Source:** `flow_sdk/fs_records/claude/claude_active_session.py`

This class method is the entry point for building a single active session record from a JSONL file. It is called per-file during the full scan in `ClaudeActiveSessionsFsRecord.entries`.

```python
_HEAD_LINES = 20

@classmethod
def from_jsonl(cls, jsonl_path: Path, max_active_seconds: int) -> Self | None:
    try:
        mtime = jsonl_path.stat().st_mtime
    except OSError:
        return None

    if time.time() - mtime > max_active_seconds:
        return None
    ...
```

#### Staleness Check Algorithm

The check is performed before any file content is read:

```
elapsed = time.time() - mtime
if elapsed > max_active_seconds:
    return None
```

- `time.time()` returns the current Unix timestamp as a float.
- `mtime` is the file's last modification time from `stat().st_mtime`.
- If the difference exceeds `max_active_seconds`, the file is considered stale and `None` is returned immediately. No further I/O is performed.

#### Head Read for Metadata

If the file passes the staleness check, the method reads at most `_HEAD_LINES = 20` lines from the start of the file to extract envelope fields:

```python
with open(jsonl_path, encoding="utf-8") as fh:
    for idx, line in enumerate(fh):
        if idx >= _HEAD_LINES:
            break
        line = line.strip()
        if not line:
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not slug:
            slug = raw.get("slug", "")
        if not git_branch:
            git_branch = raw.get("gitBranch", "")
        if not cwd:
            cwd = raw.get("cwd", "")
        if not version:
            version = raw.get("version", "")
        if not started_at:
            ts = raw.get("timestamp")
            if ts:
                started_at = ts
        if slug and git_branch and cwd and version and started_at:
            break
```

All five envelope fields are collected using a first-found strategy: each field is recorded only when it has not yet been populated. The inner loop terminates early once all five fields are populated, potentially reading fewer than 20 lines.

Fields extracted from the head:

| Field | JSON key | Description |
|---|---|---|
| `slug` | `slug` | Human-readable session label |
| `git_branch` | `gitBranch` | Git branch active when session started |
| `cwd` | `cwd` | Working directory |
| `version` | `version` | Claude Code version string |
| `started_at` | `timestamp` | ISO timestamp from the first entry |

#### Byte-Level Message Count

After the head read, a full byte scan of the file is performed to count messages without JSON parsing every line:

```python
def _fast_message_count(path: Path) -> int:
    try:
        raw = path.read_bytes()
    except OSError:
        return 0
    return (
        raw.count(b'"type":"user"')
        + raw.count(b'"type": "user"')
        + raw.count(b'"type":"assistant"')
        + raw.count(b'"type": "assistant"')
    )
```

This reads the file in its entirety as bytes and counts four byte patterns:

| Pattern | Accounts for |
|---|---|
| `b'"type":"user"'` | Compact JSON format |
| `b'"type": "user"'` | Spaced JSON format |
| `b'"type":"assistant"'` | Compact JSON format |
| `b'"type": "assistant"'` | Spaced JSON format |

The result is the sum of all four counts. This is an approximation: it counts occurrences of those byte patterns anywhere in the file (including inside string values), not just at the top-level `type` key. In practice JSONL transcripts do not repeat these patterns in nested content, so the count is accurate for normal sessions.

#### Fields Set on the Returned Record

When `from_jsonl` succeeds, it constructs a `ClaudeActiveSessionFsRecord` with the following fields:

| Field | Source |
|---|---|
| `session_id` | `jsonl_path.stem` (filename without extension) |
| `project` | `jsonl_path.parent.name` (the project directory name) |
| `cwd` | Extracted from head read |
| `version` | Extracted from head read |
| `git_branch` | Extracted from head read |
| `started_at` | Extracted from head read |
| `last_active` | `datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()` |
| `jsonl_path` | `str(jsonl_path)` |
| `slug` | Extracted from head read |
| `message_count` | Result of `_fast_message_count()` |
| `uptime` | Formatted duration from `started_at` to now |

---

### `ClaudeActiveSessionsFsRecord` — Full Scan

**Source:** `flow_sdk/fs_records/claude/claude_active_sessions.py`

This record is a container that triggers a full scan of all project directories. It does not store sessions persistently — it recomputes them on every access to `entries`.

```python
_DEFAULT_MAX_ACTIVE_SECONDS = 300  # 5 minutes
```

The default threshold is **300 seconds (5 minutes)**.

#### Construction

The record defaults to scanning `~/.claude/projects` as determined by `get_user_home_path() / ".claude" / "projects"`. Both the directory and the threshold are overridable via constructor kwargs:

```python
ClaudeActiveSessionsFsRecord(
    projects_dir="/custom/path",
    max_active_seconds=600,
)
```

#### `entries` Property — The Scan

```python
@property
def entries(self) -> list[ClaudeActiveSessionFsRecord]:
    t0 = time.perf_counter()
    pdir = Path(self.projects_dir)
    if not pdir.is_dir():
        self.scan_time_ms = (time.perf_counter() - t0) * 1000
        return []

    results: list[ClaudeActiveSessionFsRecord] = []
    for jsonl in pdir.glob("*/*.jsonl"):
        entry = ClaudeActiveSessionFsRecord.from_jsonl(
            jsonl, self.max_active_seconds,
        )
        if entry is not None:
            results.append(entry)

    results.sort(key=lambda e: e.last_active, reverse=True)
    self.scan_time_ms = (time.perf_counter() - t0) * 1000
    return results
```

Scan steps:

1. Record start time using `time.perf_counter()` for sub-millisecond accuracy.
2. Use `pdir.glob("*/*.jsonl")` to enumerate all JSONL files in any immediate subdirectory of the projects directory.
3. For each file, call `ClaudeActiveSessionFsRecord.from_jsonl(jsonl, max_active_seconds)`. Files that fail the staleness check return `None` and are excluded.
4. Sort surviving results in descending order by `last_active` (most recently modified file first).
5. Record `scan_time_ms` as elapsed milliseconds.

The scan touches the filesystem for every `.jsonl` file found: one `stat` call for the mtime check, and — if the file is active — one partial read (up to 20 lines) plus one full byte read. Stale files incur only the `stat` cost.

#### Convenience Class Methods

| Method | Description |
|---|---|
| `ClaudeActiveSessionsFsRecord.default(max_active_seconds)` | Create an instance without triggering the scan |
| `ClaudeActiveSessionsFsRecord.scan(max_active_seconds)` | Create and immediately trigger the scan, return self |

---

### `ClaudeSessionFsRecord.is_active()`

**Source:** `flow_sdk/fs_records/claude/claude_session.py`

`ClaudeSessionFsRecord` (the full transcript record, not the active-session record) also provides an `is_active` check:

```python
def is_active(self, max_seconds: int = 300) -> bool:
    path = self.data.get("jsonl_path") or self.data.get("source_file")
    if not path:
        return False
    try:
        mtime = Path(path).stat().st_mtime
    except OSError:
        return False
    return (time.time() - mtime) <= max_seconds
```

The condition here uses `<=` (inclusive boundary) versus `ClaudeActiveSessionFsRecord.from_jsonl()` which uses `>` (exclusive: returns `None` when `elapsed > threshold`). They are semantically equivalent at the threshold boundary but differ by one comparison direction. The default threshold is also 300 seconds here, matching the container default.

---

## `SourceFileRecordList` — Config File Extraction

**Source:** `flow_sdk/fs_store/source_file_record_list.py`

`SourceFileRecordList` is used when multiple records are embedded within a single JSON config file, such as a settings file or project configuration. Unlike the standard `~/.flow/records/` layout, there is no folder per record; instead records are identified by their position within the JSON document using RFC 6901 JSON Pointers.

### Class Structure

```python
@dataclass
class SourceFileRecordList:
    source_file: Path | str = ""
    root_type: str = ""
    _cache: list[Record] | None = field(default=None, repr=False, init=False)
```

The `_cache` field is populated lazily on first access and is invalidated by `reload()`.

### The `_extract()` Override Pattern

Subclasses must override `_extract(data)` to define how records are produced from the parsed JSON:

```python
def _extract(self, data: dict) -> list[Record]:
    raise NotImplementedError
```

The method receives the full deserialized JSON document as a dict and must return a list of `Record` instances. Each record should have these fields set:

| Field | Purpose |
|---|---|
| `json_path` | RFC 6901 pointer to the record's position in the source file (e.g. `"/mcpServers/my-server"`) |
| `source_file` | Path to the source JSON file |
| `parent_ref` | Reference to the parent record if the record is nested |

Example of what a minimal subclass extraction looks like:

```python
def _extract(self, data: dict) -> list[Record]:
    results = []
    for key, value in data.get("mcpServers", {}).items():
        rec = MyServerRecord.from_dict(value)
        rec.json_path = f"/mcpServers/{_escape_json_pointer(key)}"
        rec.source_file = str(self.source_file)
        results.append(rec)
    return results
```

### Cache and Lazy Loading

```python
def _ensure_cache(self) -> list[Record]:
    if self._cache is None:
        data = self._load_data()
        self._cache = self._extract(data) if data else []
    return self._cache
```

The first call to `records`, `__iter__`, `__len__`, `get()`, or `by_type()` triggers `_load_data()` (one file read and JSON parse) followed by `_extract()`. Subsequent accesses return the cached list. Call `reload()` to force a re-read.

### Write-Back via `json_path`

When `_extract` sets `json_path` on each record, the list can write individual records back to the source file using JSON Pointer navigation:

```python
def _write_record_to_source(self, record: Record) -> None:
    fragment = self._record_to_json(record)
    file_data = self._load_data() or {}

    if not record.json_path or record.json_path == "/":
        file_data.update(fragment)
    else:
        _set_pointer(file_data, record.json_path, fragment)

    self._save_data(file_data)
    self.reload()
```

For root records (`json_path` is empty or `"/"`), the entire file content is updated in-place. For nested records, `_set_pointer` navigates to the correct position and replaces that subtree.

### Public CRUD API

The list exposes public methods for reading and writing records:

| Method | Signature | Description |
|---|---|---|
| `get` | `(record_type, uid) -> Record \| None` | Linear search; returns first record matching type and uid |
| `by_type` | `(record_type) -> list[Record]` | Filter all cached records by type |
| `update` | `(record_type, uid, data) -> Record` | Apply field updates and write back; raises `KeyError` if not found, `ReadOnlyRecordError` if read-only; calls `reload()` after write |
| `delete_record` | `(record_type, uid) -> bool` | Delete JSON fragment via `json_path`; raises `ValueError` for root records (`not record.json_path`), `ReadOnlyRecordError` if read-only; calls `reload()` after write |

`update()` uses dataclass-aware branching: for dataclass `Record` subclasses, known fields are set via `setattr`, unknown fields go to `record.raw_json[key]`; for non-dataclass `Record` subclasses, all fields go via `setattr` (which routes to `_data`).

### Infrastructure Field Exclusion

When converting a record back to JSON via `_record_to_json`, fields belonging to the Record infrastructure are excluded. The exclusion set used in `source_file_record_list.py` is:

```python
_INFRA_FIELDS = frozenset({
    "id", "type", "name", "status", "created_at", "modified_at",
    "created_by", "updated_by", "scope", "source_file", "path",
    "entity_id", "raw_json", "children_refs", "parent_ref",
    "origin_ref", "json_path", "fs_sync", "storage_layout",
})
```

Non-dataclass `Record` subclasses are additionally checked against `record._INFRA_FIELDS` from `record.py`, which adds `data_ref` and the legacy alias keys.

Domain fields are converted from `snake_case` to `camelCase` for JSON output using `_snake_to_camel`.

---

## `RecordQuery` — Filtering, Sorting, and Pagination

**Source:** `flow_sdk/fs_store/record_query.py`

`RecordQuery` is a dataclass that encapsulates filter criteria, sort order, and pagination parameters. It operates on any iterable of `Record` objects returned by `discover()` or `SourceFileRecordList.records`.

### Filter Fields

All filter fields are `None` by default, meaning no constraint. Active constraints are AND-ed together.

| Field | Type | Description |
|---|---|---|
| `ids` | `list[str] \| None` | Include only records whose `uid` is in this list |
| `types` | `list[str] \| None` | Include only records whose `type` is in this list |
| `status` | `str \| list[str] \| None` | Match record status; single string for exact match, list for any-of |
| `created_after` | `datetime \| None` | Exclude records with `created_at` before this datetime |
| `created_before` | `datetime \| None` | Exclude records with `created_at` after this datetime |
| `modified_after` | `datetime \| None` | Exclude records with `modified_at` before this datetime |
| `modified_before` | `datetime \| None` | Exclude records with `modified_at` after this datetime |
| `parent_id` | `str \| None` | Include only records whose `parent_ref.id` equals this value |
| `child_filter` | `RecordQuery \| None` | Declared field for recursive composition (not evaluated by `matches` directly) |
| `predicate` | `Callable[[Record], bool] \| None` | Arbitrary caller-supplied function for custom logic |

### Sorting Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `sort_by` | `str \| None` | `None` | Attribute name to sort by: `"created_at"`, `"modified_at"`, `"name"`, or any record attribute |
| `sort_desc` | `bool` | `True` | Sort descending when `True`, ascending when `False` |

### Pagination Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `offset` | `int` | `0` | Number of records to skip after filtering and sorting |
| `limit` | `int \| None` | `None` | Maximum number of records to return; `None` means no limit |

### `matches()` Method

```python
def matches(self, record: Record) -> bool:
    if self.ids is not None and record.uid not in self.ids:
        return False
    if self.types is not None and record.type not in self.types:
        return False
    if self.status is not None:
        rec_status = str(record.status) if record.status else ""
        if isinstance(self.status, list):
            if rec_status not in self.status:
                return False
        elif rec_status != self.status:
            return False
    if self.created_after is not None:
        ca = record.created_at
        if ca is None or ca < self.created_after:
            return False
    if self.created_before is not None:
        ca = record.created_at
        if ca is None or ca > self.created_before:
            return False
    if self.modified_after is not None:
        ma = record.modified_at
        if ma is None or ma < self.modified_after:
            return False
    if self.modified_before is not None:
        ma = record.modified_at
        if ma is None or ma > self.modified_before:
            return False
    if self.parent_id is not None:
        pr = record.parent_ref
        parent_ok = pr is not None and pr.id == self.parent_id
        if not parent_ok:
            return False
    if self.predicate is not None and not self.predicate(record):
        return False
    return True
```

Key behaviors:

- Records with `created_at = None` or `modified_at = None` fail any date range constraint that involves those fields. `None` dates are not treated as "unknown" — they are treated as non-matching.
- `status` comparison converts `record.status` to a string via `str()` before comparing. If the record has no status, the empty string `""` is used. This means a query with `status=""` matches records with no status set.
- `parent_id` is compared against `parent_ref.id`. If the record has no `parent_ref`, it does not match.

### `apply()` Method

```python
def apply(self, records: Iterable[Record]) -> list[Record]:
    result = [r for r in records if self.matches(r)]

    if self.sort_by:
        key_attr = self.sort_by
        def _sort_key(r: Record) -> Any:
            val = getattr(r, key_attr, None)
            if val is None:
                return (1, "")
            return (0, val)
        result.sort(key=_sort_key, reverse=self.sort_desc)

    if self.offset:
        result = result[self.offset:]
    if self.limit is not None:
        result = result[:self.limit]

    return result
```

Steps:

1. Filter — builds a new list containing only records that pass `matches()`.
2. Sort — if `sort_by` is set, sorts using a two-element key tuple. Records where the sort attribute is `None` receive `(1, "")`, pushing them to the end of the result regardless of `sort_desc`.
3. Paginate — applies `offset` (slice from that index) then `limit` (truncate at that length).

### Usage Example

```python
from datetime import datetime, timezone
from flow_sdk.fs_store.record_query import RecordQuery
from flow_sdk.fs_records.claude.claude_session import ClaudeSessionFsRecord

q = RecordQuery(
    types=["claude_session"],
    modified_after=datetime(2026, 1, 1, tzinfo=timezone.utc),
    sort_by="modified_at",
    sort_desc=True,
    limit=20,
)

all_sessions = ClaudeSessionFsRecord.discover()
recent = q.apply(all_sessions)
```

---

## Performance Summary

| Operation | Complexity | Notes |
|---|---|---|
| `Record.discover()` | O(N) | N = number of subdirectories in the type directory |
| `Record.discover_one()` | O(1) | Constant — two filesystem checks plus one file read |
| `ClaudeSessionFsRecord.discover()` | O(P * S * L) | P = projects, S = sessions per project, L = lines per JSONL |
| `ClaudeSessionFsRecord.discover_one()` with `project` kwarg | O(L) | One JSONL file read, L = lines |
| `ClaudeSessionFsRecord.discover_one()` without `project` kwarg | O(P * L) | Scans all projects until found |
| `ClaudeActiveSessionsFsRecord.entries` | O(F * (1 + H + B)) | F = files found by glob; H = head read (up to 20 lines) per active file; B = byte scan per active file. Stale files cost only one `stat`. |
| `SourceFileRecordList.records` (first access) | O(1 file read + extract) | Subsequent accesses return cached list |
| `RecordQuery.apply()` | O(N log N) | N = input records; dominated by the sort step |
| `SchemaRegistry.discover()` | O(T * N) | T = number of types, N = records per type |
| `SchemaRegistry.incremental()` | O(T' * N) | T' = stale types only (skips recently indexed) |

---

## SchemaRegistry Scan & Index Orchestration

**Source:** `flow_sdk/fs_store/schema_registry.py`

The `SchemaRegistry` (aliased as `SchemaRecord` in `flow_sdk/fs_records/schema_record.py`) provides a higher-level orchestration layer on top of `Record.discover()`. While `Record.discover()` scans a single type's directory, `SchemaRegistry.discover()` iterates across multiple registered types, scanning and indexing each one, and logging operations to JSONL files under `~/.flow/schema/`.

### Two Scan Layers

| Layer | Class | Purpose | Scope |
|---|---|---|---|
| **Filesystem scan** | `Record.discover()` | O(N) directory iteration for a single record type | One type at a time |
| **Orchestration** | `SchemaRegistry.discover()` | Iterates registered types, calls `_scan_type()` + `index_type()` for each, logs results | All default types or a specified subset |

### Default Indexed Types

The following types are indexed by default when no explicit type list is provided:

```python
_BUILTIN_DEFAULT_TYPES = ["skill", "memo", "agent", "task", "agentic_process"]
```

Additional types can register themselves as `indexed_by_default=True` via `SchemaRegistry.register(TypeInfo(...))`.

> **Note:** `record_error` and `claude_error` are **not** in the default index types. They have their own parallel discovery path via `ClaudeErrorRecordList._do_sync()` (see [Error Record Handling](#error-record-handling) below).

### Key Methods

#### `SchemaRegistry.discover(types, trigger, limit_per_type, actions)`

Full scan+index for given or default types.

```python
scan_results, index_results = await SchemaRegistry.discover(
    types=["skill", "memo"],      # None = use default types
    trigger="manual",              # logged in scan_log.jsonl
    limit_per_type=100,            # cap records scanned/indexed per type
    actions=["scan", "index"],     # can omit "index" for scan-only
)
```

For each type:
1. `_scan_type(record_cls, limit)` — iterates records via `RecordList`, collects count + total_bytes → `ScanResult`
2. `index_type(record_cls, limit)` — calls `rec.sync_to_db()` on each record (persists to SQLite FTS5) → `IndexResult`
3. Logs per-type and global results to `~/.flow/schema/scan_log.jsonl` and `~/.flow/schema/types/<type>/scan_log.jsonl`

#### `SchemaRegistry.incremental(request: IndexRequest)`

Scans+indexes only types not indexed since `request.start_time`. Skips types whose last index timestamp is newer than the cutoff.

#### `SchemaRegistry.rebuild_index(types, trigger)`

Clears the index for the given types (or all), then re-indexes from scratch. Calls `clear_index()` then `index_type()` for each type.

#### `SchemaRegistry.clear_index(types)`

Deletes FTS entries and entities from the database. Also clears `RecordError` records for the affected types. Removes per-type `index_log.jsonl` files.

#### `SchemaRegistry.get_index_status(types)`

Returns an `IndexStatus` dataclass with:
- `never_indexed: bool` — whether any global index has ever run
- `last_indexed_at: str | None` — ISO timestamp of last global index
- `stale: bool` — `True` if last index was >24 hours ago
- `per_type: list[TypeIndexStatus]` — per-type last scan/index timestamps and staleness

### Scan Logging

All scan and index operations are logged to JSONL files under `~/.flow/schema/`:

```
~/.flow/schema/
  scan_log.jsonl                          — global scan log
  index_log.jsonl                         — global index log
  types/<sanitized_type>/
    type_info.json                        — persisted TypeInfo
    scan_log.jsonl                        — per-type scan log
    index_log.jsonl                       — per-type index log
```

Each log file is capped at 100 entries (oldest trimmed on append). See [schema-registry.md](schema-registry.md) for full details on the schema registry.

---

## Scan & Discovery API Endpoints

### Search / Reindex Endpoints

**Source:** `flow_sdk/server/routes/search.py`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/search?q=...&limit=10&record_type=...&status=...` | FTS5 full-text search of indexed records |
| `POST` | `/api/v1/search/reindex` | Re-index all default types via `SchemaRegistry.discover(trigger="reindex")` |
| `POST` | `/api/v1/search/reindex/{record_type}` | Re-index a single type via `RecordList` + `rec.sync_to_db()` |

### Bootstrap scan_info

The bootstrap endpoint (`GET /api/v1/graph/bootstrap`) includes a `scan_info` field in its response, computed by `get_scan_info()` in `flow_sdk/system_tools.py`:

```json
{
  "total_indexed": 0,
  "last_indexed_at": "2026-03-10T14:23:00+00:00",
  "never_indexed": false,
  "stale": true
}
```

This reads `SchemaRegistry.get_index_status()` — no DB query, just checks log file timestamps.

### Discovery Action (ComputeNode)

**Source:** `flow_sdk/builtin/faas/compute_node.py:1208`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/graph/compute_node/@local/discovery/<record_type>` | Discover records of a given type |

Query params:
- `uuid` (optional): Specific record UUID to discover (calls `discover_one()`)
- `project` (optional): Project path for O(1) session lookup

**Supported types:** Currently only `claude_session` and `session` are mapped to `ClaudeSessionRecord`. Other record types return an error despite the generic endpoint path.

**Response behavior:**
- With `uuid` found: `200 SUCCESS` with record dict (runs `discovery(force=True)` first)
- With `uuid` not found: `200 SUCCESS` with `data: null` — **not** 4xx. This is intentional because session files may not exist yet during startup (race condition). A 4xx would cause browser console errors via Axios.
- Without `uuid`: `200 SUCCESS` with list of all discovered record dicts
- On exception: `200 SUCCESS` with `data: null` (catches all errors silently)

### Removed Endpoints

The `POST /fs-records/index` and `GET /fs-records/scan` endpoints referenced in some older documentation no longer exist. Scan and index operations are now accessed via the `/api/v1/search/reindex` endpoints and `SchemaRegistry` methods.

---

## Error Record Handling

### RecordError (Base)

**Source:** `flow_sdk/fs_records/record_error.py`

`RecordError` (`_record_type = "record_error"`) is a structured error record created when indexing fails. Created via `RecordError.from_exception(record, exc, trigger)`.

- Stored in `~/.flow/records/record_error/` using standard FOLDER layout
- `discover()` override: when called on the base class, also traverses registered subtypes via `SchemaRegistry.get_subtypes("record_error")`
- `clear_for_type(type_name)` and `clear_all()` are called during `SchemaRegistry.clear_index()`

### ClaudeErrorRecord (Extended)

**Source:** `flow_sdk/fs_records/claude/claude_error.py`

`ClaudeErrorRecord` (`_record_type = "claude_error"`) extends `RecordError` with fingerprint-based deduplication and triage capabilities.

**Discovery path (parallel to SchemaRegistry):**

Unlike standard record types, `claude_error` records are NOT discovered via `SchemaRegistry.discover()`. Instead, they have their own sync pipeline:

1. **Startup sync:** `run_startup_sync()` runs in a background thread at server start (`flow_sdk/server/app.py`)
   - Deletes debug logs older than 7 days from `~/.claude/debug/`
   - Runs `discovery(force=False)` on each `ClaudeSessionDebugLogRecord`
   - Creates a warning record if debug dir exceeds 400 MB
2. **Per-request sync:** `ClaudeErrorRecordList._do_sync()` throttled to 30-second intervals
   - Parses `~/.claude/debug/*.txt` files via `parse_debug_log()`
   - Upserts errors by fingerprint (SHA256 of normalized error text, truncated to 12 chars)
   - Two categories: `hook` errors and `log` errors
   - Occurrence tracking: count, first/last seen, session IDs, capped at 50 per fingerprint

**Triage statuses:** `open`, `ignored`, `ignored_until`, `task_created`

- `ignored_until` auto-reopens when the snooze expires (checked during sync)
- Records older than the time window (default 168 hours) are pruned during sync

---

## Known Issues

### `ValueError` Not Caught in `Record.discover()`

The `discover()` method catches `json.JSONDecodeError` and `OSError` but does **not** catch `ValueError`, which is raised by `read_record()` when a record file is empty. An empty `record.json` (e.g., from a crash-interrupted write) will abort the entire scan for that type. This is a latent bug.

### Discovery Action Limited to 2 Types

The `_discovery_action` on `ComputeNode` only maps `claude_session` and `session` to `ClaudeSessionRecord`. Despite the generic endpoint path (`/discovery/<record_type>`), no other record types are supported. Requests for unmapped types return `ApiFailResponse(message="Unknown record type: ...")`.
