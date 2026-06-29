---
id: "db0e242f-fd81-5bcf-a295-6230a3c420ea"
---

# Record Discovery & PropertyRecord System

> **Naming note:** This document covers the **Record-level discovery** mechanism (`Record.discovery()`, `PropertyRecord` descriptors, and `state.json` TTL caching). It does **not** cover the **Flowpad app discovery** module (`flow_sdk/discovery/flowpad_discovery.py`), which detects whether the Flowpad desktop app is running via `~/.flow/server.json` and health checks. For Flowpad app discovery, see [`flow_sdk/discovery/`](../flow_sdk/discovery/__init__.py). For filesystem indexing, see [`flow_sdk/fs_store/indexer/`](../flow_sdk/fs_store/indexer/__init__.py).

## Overview

The `Record` class in `flow_sdk/fs_store/` now supports a three-layer storage model:

| Layer          | File               | Description                                           |
| -------------- | ------------------ | ----------------------------------------------------- |
| **DomainData** | `data.json`        | All domain fields (id, name, status, …)               |
| **Metadata**   | inside `data.json` | name, status, created\_at, etc. (merged into `_data`) |
| **State**      | `state.json`       | Discovery flag + cached PropertyRecord values         |

`state.json` lives in the same folder as `metadata.json` (FOLDER layout). For read-only records without a folder path (e.g. JSONL-backed sessions), saves are silently skipped.

***

## PropertyRecord — Pydantic-Field-style descriptors

`PropertyRecord` is a **descriptor class** inspired by Pydantic's `Field` pattern. Assign one at class level, and Python calls `__set_name__` automatically to register it in the class's `_property_types` dict. Access it on an instance and `__get__` returns the cached, TTL-aware value.

```python
from flow_sdk.fs_store import PropertyRecord, Record

class MyRecord(Record):
    _record_type = "my_record"

    # Scalar property — inline discovery lambda
    is_ready = PropertyRecord(
        ttl=60,
        discovery=lambda r: r._data.get("status") == "ready",
    )

    # List property — named storage key for readability in state.json
    errors = PropertyRecord(
        ttl=300,
        list_key="errors",          # stored as {"errors": [...]} not {"value": [...]}
        discovery=lambda r: [],
    )

    # Never auto-expires on get_prop(); refreshed only by discovery(force=True)
    fingerprint = PropertyRecord(
        ttl=-1,
        discovery=lambda r: hash(r.id),
    )

# Instance access — TTL-aware, transparent:
rec = MyRecord(status="ready")
rec.is_ready   # → True (computed on first access, cached for 60s)
rec.errors     # → [] (list, stored under key "errors")
rec.fingerprint  # → int (set once, never auto-invalidated)
```

### Subclassing PropertyRecord

For complex discovery logic, subclass and override `run_discovery()`:

```python
class SessionActivePropertyRecord(PropertyRecord):
    _record_type = "prop_session_active"
    _default_ttl = -1  # class-level TTL default

    def run_discovery(self, instance, force=False):
        path = instance._data.get("jsonl_path")
        if path:
            try:
                return (time.time() - Path(path).stat().st_mtime) <= 300
            except OSError:
                pass
        return False

class ClaudeSessionRecord(Record):
    _record_type = "session"
    _read_only = True

    is_active: bool = SessionActivePropertyRecord()
```

The subclass is instantiated as the descriptor (`SessionActivePropertyRecord()`).
`_default_ttl` on the subclass provides the default when no `ttl=` kwarg is passed.

***

## `state.json` format

```json
{
  "fields": {
    "is_ready": {
      "type": "property",
      "ttl": 60,
      "value": true,
      "discovered_at": "2026-03-10T14:23:00+00:00"
    },
    "errors": {
      "type": "prop_errors",
      "ttl": 300,
      "errors": ["timeout on line 42"],
      "discovered_at": "2026-03-10T14:23:00+00:00"
    }
  },
  "meta": { "id": "...", "type": "...", "name": "..." }
}
```

`discovered_at` is inferred from the file's presence (if `state.json` exists and has a `fields` key, the record is considered discovered). List properties use their `list_key` as the storage key instead of `"value"`.

***

## `Record.discovery()`

```python
record.discovery(force=False, recursive=False) -> Record
```

| `force` | `already_discovered` | Behaviour                                                   |
| ------- | -------------------- | ----------------------------------------------------------- |
| `False` | No                   | Full scan: reload `data.json` + run all properties          |
| `False` | Yes                  | Skip `data.json` reload; re-run **expired** properties only |
| `True`  | Any                  | Always reload `data.json` + re-run **all** properties       |

`recursive=True` propagates the same call to all `children` loaded via `children_refs`.

Returns `self` for chaining.

***

## `Record.get_prop(key)`

TTL-aware accessor. Checks the `RecordState` for a cached entry:

1. If no entry or entry is expired → calls `descriptor.run_discovery()`, stores result, persists `state.json`
2. If entry is fresh → returns `descriptor.get_value(entry)` directly (no discovery)
3. If no descriptor registered for `key` → falls back to `self._data.get(key)`

***

## TTL rules

| `ttl` value             | Behaviour                                                                         |
| ----------------------- | --------------------------------------------------------------------------------- |
| `> 0`                   | Re-run if `(now - discovered_at).total_seconds() > ttl`                           |
| `-1`                    | Never auto-invalidates on `get_prop()`. Only refreshed by `discovery(force=True)` |
| Missing `discovered_at` | Always treated as expired                                                         |

***

## `list_key` parameter

When a property's value is a list, pass `list_key="my_key"` to store it under a named key in `state.json` instead of the generic `"value"` key. This improves readability in the file and is required when the list may need to be introspected directly.

```python
# Without list_key:   {"value": ["a", "b"]}
# With list_key="items": {"items": ["a", "b"]}

tags = PropertyRecord(ttl=300, list_key="items", discovery=lambda r: get_tags(r))
```

Non-list values passed to a `list_key` descriptor are coerced to `[]`.

***

## Source layout

```
flow_sdk/
  fs_store/
    record.py               # Record base class (discovery, get_prop, _get_state, _reload_from_disk)
    property_record.py      # PropertyRecord descriptor base class
    record_state.py         # RecordState (manages state.json)

flow_sdk/fs_records/claude/
  claude_session.py         # ClaudeSessionRecord (is_active descriptor)
  properties/
    __init__.py
    session_active.py       # SessionActivePropertyRecord (subclass example)
```

***

## Read-only records

Records with `_read_only = True` (e.g. `ClaudeSessionRecord`) may have no folder path. `RecordState.save()` silently skips writing when `_state_path()` returns `None`. Properties still compute on `get_prop()` — values are just not persisted across calls.

***

## Testing

```bash
python -m pytest tests/unit/test_records.py -v
```

Key scenarios tested:

* `discovery(force=False)` on fresh record → full scan + writes `state.json`

* `discovery(force=False)` on known record → skips `data.json`; re-runs expired TTLs

* `discovery(force=True)` → always reloads `data.json` + re-runs all props

* `get_prop()` first access, cached, TTL expiry, `ttl=-1`, fallback to `_data`

* Corrupted `state.json` → silently ignored

* Missing source file → no crash, still marks discovered

* Read-only record → no `state.json` written

* `list_key` storage/retrieval round-trip

* Child class inherits + extends parent descriptors

* Rapid repeated access → discovery called only once (no excess calls)

