"""Index-run log — the on-disk bookkeeping of scan / index runs and their status.

Plain functions and dataclasses; nothing here is a type-registry concern. The
registry (``SchemaRegistry``) is consulted lazily, inside functions, for the
type lists it owns (default index types, browseable types, record types).

Files:
  <schema_dir>/scan_log.jsonl                          — global scan log
  <schema_dir>/index_log.jsonl                         — global index log
  <schema_dir>/types/<sanitized_type>/scan_log.jsonl   — per-type scan log
  <schema_dir>/types/<sanitized_type>/index_log.jsonl  — per-type index log
  <schema_dir>/scan_issues.jsonl                       — scan issues (no type)
  <schema_dir>/types/<sanitized_type>/scan_issues.jsonl — per-type scan issues

Each log file keeps at most ``_MAX_LOG_ENTRIES`` entries (oldest trimmed on append).
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.instance_settings import get_instance_settings

_MAX_LOG_ENTRIES: int = 100

SCAN_LOG = "scan_log.jsonl"
INDEX_LOG = "index_log.jsonl"
SCAN_ISSUES_LOG = "scan_issues.jsonl"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _schema_dir() -> Path:
    """Resolve the per-instance schema dir at call time.

    Lives on InstanceSettings — never cache the result, never construct
    `~/.flow/<...>/schema` directly. This getter is the single chokepoint.
    """
    return get_instance_settings().schema_dir


def _sanitize_type_name(type_name: str) -> str:
    """Make a type name safe for use as a directory/file name component."""
    return type_name.replace(":", "__").replace(" ", "_")


def _schema_dir_for(type_name: str) -> Path:
    return _schema_dir() / "types" / _sanitize_type_name(type_name)


def _log_path(name: str, type_name: str | None) -> Path:
    """``<schema_dir>/<name>`` for the global log, ``.../types/<t>/<name>`` per type."""
    return _schema_dir_for(type_name) / name if type_name else _schema_dir() / name


# ---------------------------------------------------------------------------
# JSONL helpers
# ---------------------------------------------------------------------------


def _append_jsonl(path: Path, entry: dict[str, Any]) -> None:
    """Append one JSON line to *path*, then trim to _MAX_LOG_ENTRIES lines."""
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(entry, default=str) + "\n"
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(line)
    _trim_jsonl(path)


def _trim_jsonl(path: Path) -> None:
    """If the file exceeds _MAX_LOG_ENTRIES lines, keep only the last N."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
        if len(lines) <= _MAX_LOG_ENTRIES:
            return
        keep = lines[-_MAX_LOG_ENTRIES:]
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.writelines(keep)
        tmp.replace(path)
    except Exception:
        pass


def _read_entries(path: Path) -> list[dict[str, Any]]:
    """All JSON objects in a JSONL file, oldest first; ``[]`` when absent/unreadable."""
    try:
        if not path.exists():
            return []
        with open(path, "r", encoding="utf-8") as fh:
            return [json.loads(ln) for ln in fh if ln.strip()]
    except Exception:
        return []


def _read_last_entry(path: Path) -> dict[str, Any] | None:
    """Return the last JSON object from a JSONL file, or None."""
    entries = _read_entries(path)
    return entries[-1] if entries else None


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass
class ClearResult:
    fts_cleared: int
    entities_cleared: int
    types_cleared: list[str]


@dataclass
class TypeIndexStatus:
    type_name: str
    last_indexed_at: str | None
    entity_count: int
    stale: bool
    orphan_count: int = 0


@dataclass
class IndexStatus:
    never_indexed: bool
    last_indexed_at: str | None
    stale: bool
    default_types: list[str]
    per_type: list[TypeIndexStatus]
    total_orphans: int = 0


@dataclass
class AssetStats:
    """Live per-type asset counts for a ScopeFilter — counts only. Freshness
    and orphans deliberately live in ``IndexStatus`` / ``get_index_status``;
    this is the single source the UI counter surfaces render from."""

    per_type: dict[str, int]
    total: int


# ---------------------------------------------------------------------------
# Scan issues — what a walk saw and could not (or would not) adopt
# ---------------------------------------------------------------------------

ScanIssueKind = Literal[
    "unclassified_in_family_dir",  # a file in a typed family dir no TypeInfo claimed
    "foreign_id",  # a carrier value that is not an accepted id, or a retired form (ignored, v5 minted)
    "malformed_carrier",  # the carrier (frontmatter / sidecar) could not be parsed
]

UNCLASSIFIED_IN_FAMILY_DIR: ScanIssueKind = "unclassified_in_family_dir"
FOREIGN_ID: ScanIssueKind = "foreign_id"
MALFORMED_CARRIER: ScanIssueKind = "malformed_carrier"


@dataclass
class ScanIssue:
    path: str
    kind: ScanIssueKind
    detail: str = ""
    type_name: str | None = None
    at: str = field(default_factory=_now_iso)


def append_scan_issue(issue: ScanIssue) -> None:
    """Persist one scan issue; per-type when it names a type, else global."""
    _append_jsonl(_log_path(SCAN_ISSUES_LOG, issue.type_name), asdict(issue))




def read_scan_issues(type_name: str | None = None) -> list[ScanIssue]:
    """Issues logged for *type_name* (or the untyped global log), oldest first."""
    out: list[ScanIssue] = []
    for raw in _read_entries(_log_path(SCAN_ISSUES_LOG, type_name)):
        try:
            out.append(ScanIssue(**raw))
        except TypeError:
            continue
    return out


# ---------------------------------------------------------------------------
# Scan / index run logs
# ---------------------------------------------------------------------------


def append_scan(
    trigger: str,
    duration_ms: float,
    total_records: int,
    total_bytes: int,
    types: list[dict[str, Any]],
    type_name: str | None = None,
) -> str:
    """Log a scan operation. Returns the ISO timestamp written."""
    now = _now_iso()

    def _entry(name: str, ms: float, records: int, nbytes: int) -> dict[str, Any]:
        return {
            "id": mint_uuid(),
            "type": "scan_log",
            "scan_trigger": trigger,
            "duration_ms": ms,
            "total_records": records,
            "total_bytes": nbytes,
            "type_name": name,
            "created_at": now,
        }

    if type_name:
        _append_jsonl(_log_path(SCAN_LOG, type_name), _entry(type_name, duration_ms, total_records, total_bytes))
        return now

    global_entry = {
        "id": mint_uuid(),
        "type": "scan_log",
        "scan_trigger": trigger,
        "duration_ms": duration_ms,
        "total_records": total_records,
        "total_bytes": total_bytes,
        "types": types,
        "created_at": now,
    }
    _append_jsonl(_log_path(SCAN_LOG, None), global_entry)
    for t in types:
        t_name = t.get("type", "")
        if not t_name:
            continue
        _append_jsonl(
            _log_path(SCAN_LOG, t_name),
            _entry(t_name, t.get("scan_ms", 0.0), t.get("count", 0), t.get("total_bytes", 0)),
        )
    return now


def append_index(
    trigger: str,
    duration_ms: float,
    total_indexed: int,
    types: list[dict[str, Any]],
    type_name: str | None = None,
) -> str:
    """Log an index operation. Returns the ISO timestamp written.

    Per-type log only — the "global" timestamp is derived in
    ``get_index_status`` as ``max(per_type[i].last_indexed_at)``. This
    means per-type indexing (e.g. UI's "Index Now" loop) automatically
    flips ``never_indexed`` to false without needing a separate global
    write call.
    """
    now = _now_iso()

    def _entry(name: str, ms: float, indexed: int) -> dict[str, Any]:
        return {
            "id": mint_uuid(),
            "type": "index_log",
            "index_trigger": trigger,
            "duration_ms": ms,
            "total_indexed": indexed,
            "type_name": name,
            "created_at": now,
        }

    if type_name:
        _append_jsonl(_log_path(INDEX_LOG, type_name), _entry(type_name, duration_ms, total_indexed))
        return now

    for t in types:
        t_name = t.get("type", "")
        if not t_name:
            continue
        # The caller's per-type dict already carries a measured duration
        # (``types_out`` in fs_records_actions); reading ``indexed`` from it
        # while writing a literal 0.0 here left every aggregate run's audit
        # trail timeless.
        _append_jsonl(
            _log_path(INDEX_LOG, t_name),
            _entry(t_name, t.get("duration_ms", 0.0), t.get("indexed", 0)),
        )
    return now


def get_last_scan_at(type_name: str) -> str | None:
    entry = _read_last_entry(_log_path(SCAN_LOG, type_name))
    return (entry or {}).get("created_at")


def get_last_index_at(type_name: str) -> str | None:
    entry = _read_last_entry(_log_path(INDEX_LOG, type_name))
    return (entry or {}).get("created_at")


# ---------------------------------------------------------------------------
# Clear
# ---------------------------------------------------------------------------


async def clear_index(types: list[str] | None = None) -> ClearResult:
    from flow_sdk.db import get_db_driver  # noqa: PLC0415
    from flow_sdk.fs_store.operations.record_error import clear_all, clear_for_type  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    driver = get_db_driver()
    if types is None:
        fts_cleared = await driver.fts_clear() if hasattr(driver, "fts_clear") else 0
        entities_cleared = (
            await driver.delete_entities_by_type(None) if hasattr(driver, "delete_entities_by_type") else 0
        )
        global_log = _log_path(INDEX_LOG, None)
        if global_log.exists():
            global_log.unlink()
        types_dir = _schema_dir() / "types"
        if types_dir.is_dir():
            for per_type_log in types_dir.glob(f"*/{INDEX_LOG}"):
                per_type_log.unlink()
        types_cleared = SchemaRegistry.get_all_record_types()
        await clear_all()
    else:
        fts_cleared = 0
        entities_cleared = 0
        types_cleared = []
        for type_name in types:
            if hasattr(driver, "delete_entities_by_type"):
                entities_cleared += await driver.delete_entities_by_type(type_name)
            log_file = _log_path(INDEX_LOG, type_name)
            if log_file.exists():
                log_file.unlink()
            types_cleared.append(type_name)
            await clear_for_type(type_name)
    return ClearResult(
        fts_cleared=fts_cleared,
        entities_cleared=entities_cleared,
        types_cleared=types_cleared,
    )


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------


async def get_index_status(
    types: list[str] | None = None,
    scope: object | None = None,
) -> IndexStatus:
    """Snapshot of index state. DB-free for freshness.

    * **Project scope** (``scope.projects == [one id]``) — the project IS a
      record, so its three states come from the project record's own
      on-disk ``.hash`` sentinel: ``never_indexed`` = no sentinel,
      ``last_indexed_at`` = the sentinel time, ``stale`` = ``index_required``
      ("changes pending"). No child aggregation.
    * **Unscoped / type list** — footer/scanner view. ``last_indexed_at``
      per type from the JSONL run-history (audit); ``entity_count`` from
      ``count_entities_by_type`` (the live searchable count).

    ``stale`` means "changes pending next index", not a 24h timer.
    Orphan counts come from a scan, not from here.
    """
    import asyncio  # noqa: PLC0415

    from flow_sdk.db import get_db_driver  # noqa: PLC0415
    from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    driver = get_db_driver()
    per_type: list[TypeIndexStatus] = []
    latest_iso: str | None = None
    default_types = SchemaRegistry.get_default_index_types()
    target_types = list(types or default_types)

    # `stale` is the endpoint's documented contract — "changes pending next
    # index" — asked per type via `index_required`. `orphan_count` stays 0 by
    # design: orphans come from a scan, not from here. One thread hop for the
    # whole sweep, not one per type: the walk never yields to the loop between
    # types, so 30+ dispatches bought nothing.
    def _stale_by_type() -> dict[str, bool]:
        return {t: FSRecord.type_has_pending_changes(t) for t in target_types}

    stale_by_type = await asyncio.to_thread(_stale_by_type)
    nested = await _nested_counts(driver, scope)

    for type_name in target_types:
        type_last = get_last_index_at(type_name)  # JSONL run-history (audit)
        if type_last and (latest_iso is None or type_last > latest_iso):
            latest_iso = type_last
        count = await _safe_count(driver, type_name, scope, nested)
        per_type.append(
            TypeIndexStatus(
                type_name=type_name,
                last_indexed_at=type_last,
                entity_count=count,
                stale=stale_by_type.get(type_name, False),
                orphan_count=0,
            )
        )

    # Project-scoped freshness from the project record's own sentinel.
    project_id = _single_project_id(scope)
    if project_id is not None:
        prec = _project_record_for_status(project_id)
        indexed_at = prec.indexed_at if prec is not None else None
        return IndexStatus(
            never_indexed=indexed_at is None,
            last_indexed_at=indexed_at,
            stale=bool(prec.index_required) if prec is not None else False,
            default_types=default_types,
            per_type=per_type,
            total_orphans=0,
        )

    return IndexStatus(
        never_indexed=all(t.last_indexed_at is None for t in per_type),
        last_indexed_at=latest_iso,
        stale=any(t.stale for t in per_type),
        default_types=default_types,
        per_type=per_type,
        total_orphans=0,
    )


async def _safe_count(
    driver,
    type_name: str,
    scope: object | None,
    nested: dict[str, int] | None = None,
) -> int:
    """Per-type live count, tolerant of a driver whose
    ``count_entities_by_type`` predates the ``scope`` kwarg. Shared by
    ``get_index_status`` and ``get_asset_stats`` so there is one counting
    path, not two.

    ``nested`` (from ``_nested_counts``) is subtracted so the badge agrees
    with the list the user actually sees: ``/search?top_level=true`` drops
    assets nested inside another browseable asset, and a count that still
    included them would read 8 over a 4-row list. Clamped at 0 — the two
    queries are separate reads, so a concurrent write must not go negative.
    """
    try:
        total = await driver.count_entities_by_type(type_name, scope=scope)
    except TypeError:
        total = await driver.count_entities_by_type(type_name)
    except Exception:
        return 0
    return max(0, total - (nested or {}).get(type_name, 0))


async def _nested_counts(driver, scope: object | None) -> dict[str, int]:
    """Per-type count of rows nested inside a browseable asset, or ``{}``.

    Fetched ONCE per status/stats call (one grouped query), not per type.
    Fails soft to ``{}`` — a driver without the method, or a query error,
    degrades to raw counts rather than blanking the sidebar.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    try:
        return await driver.count_nested_entities_by_type(tuple(SchemaRegistry.browseable_type_names()), scope=scope)
    except Exception:
        return {}


async def get_asset_stats(scope: object | None = None) -> AssetStats:
    """Live per-type asset counts for a ScopeFilter, over the registry's
    default index types (derived, not hardcoded). Counts only; reuses the
    same per-type count path as ``get_index_status``."""
    from flow_sdk.db import get_db_driver  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    driver = get_db_driver()
    nested = await _nested_counts(driver, scope)
    per_type = {
        str(type_name): await _safe_count(driver, type_name, scope, nested)
        for type_name in SchemaRegistry.get_default_index_types()
    }
    return AssetStats(per_type=per_type, total=sum(per_type.values()))


def _single_project_id(scope: object | None) -> str | None:
    """The lone project id when ``scope`` targets exactly one project, else None."""
    projects = list(getattr(scope, "projects", None) or []) if scope is not None else []
    return projects[0] if len(projects) == 1 else None


def project_never_indexed(project_id: str) -> bool:
    """True when this project has no index sentinel on disk.

    The per-project form of ``get_index_status``'s project branch, which
    cannot serve a caller holding SEVERAL projects: ``_single_project_id``
    returns None the moment a scope names more than one, so a multi-project
    view (e.g. a project plus its context folders) has to ask per project.

    Pure filesystem read (``FSRecord.indexed_at``) — no DB, no write, no walk.
    """
    prec = _project_record_for_status(project_id)
    return prec is None or getattr(prec, "indexed_at", None) is None


def _project_record_for_status(project_id: str) -> object | None:
    """Load the project record with its asset_ref bound to the project
    folder, so ``indexed_at`` / ``index_required`` resolve. None if the
    record (or its mount path) is unknown."""
    from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415

    prec = FSRecord.load_or_none("project", project_id)
    return prec.ensure_asset_ref() if prec is not None else None


def get_errors(type_name: object | None = None) -> list:
    """RECORD_ERROR records (from the record store) followed by the
    ``ScanIssue`` entries logged for *type_name* — or, with no type, the
    untyped global scan-issue log. *type_name* may be a str or a ``TypeId``."""
    from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
    from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

    results = FSRecord.discover(RecordType.RECORD_ERROR)
    name: str | None = None
    if type_name is not None:
        name = type_name if isinstance(type_name, str) else type_name.type
        results = [
            e for e in results if e.__dict__.get("source_record_type") == name or getattr(e, "type", None) == name
        ]
    return [*results, *read_scan_issues(name)]
