"""Walker + async extractor + helpers for PROJECT records.

Both Claude and Codex indexer paths converge on this single record type by
canonical posix cwd. The parser_fn (``extract_claude_project``) is **async**
because it does real disk I/O during upsert-by-cwd (session-stat counts +
DB save) — this is the only async parser_fn in the indexer today.

Replaces the parse-side behaviour of the deleted ``ProjectFsRecord`` subclass.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flow_sdk.fs_store import RecordType
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.utils.file_system import is_temp_path

# ── Helpers (moved from ProjectFsRecord) ─────────────────────────────────────

def _claude_projects_dir() -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    return get_instance_settings().claude_projects_dir

def _flow_records_norm_prefixes() -> tuple[str, ...]:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    home_str = str(get_instance_settings().user_home)
    # Internal record folders (incl. the dev_records variant) are never user
    # projects — they must not surface in the project picker. Run each prefix
    # through os.path.normpath + os.sep so it uses the SAME separators as the
    # `normalized` cwd it's compared against in _is_valid_cwd; otherwise on
    # Windows the prefix mixes "\" (from home_str) and "/" (literals) and the
    # startswith() never matches, so the exclusion silently does nothing.
    return tuple(
        os.path.normpath(home_str + sub) + os.sep
        for sub in (
            "/.flow/records",
            "/.flow/dev_records",
            "/flow/records",
            "/flow/dev_records",
        )
    )

def _decode_claude_encoded(d: Path) -> str | None:
    from flow_sdk.fs_store.indexer.functions._claude_projects import decode_claude_project_dir  # noqa: PLC0415
    real = decode_claude_project_dir(d)
    if real is None:
        return None
    return str(real)

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

# Windows drive-rooted prefix, e.g. "C:/" or "C:\\". canonical_posix_path()
# emits forward-slash drive paths ("C:/Users/foo") while decode_claude_project_dir
# emits backslash ones ("C:\\Users\\foo"); both reach this gate, so accept either
# separator. Without this, a bare startswith("/") check drops every Windows
# project cwd and the project list comes back empty.
_WIN_DRIVE_ROOT_RE = re.compile(r"^[A-Za-z]:[/\\]")


def _is_valid_cwd(cwd: str) -> bool:
    """Reject system/temp paths and internal record folders."""
    if not cwd:
        return False
    # Accept POSIX-rooted ("/foo") and Windows drive-rooted ("C:/foo") absolute
    # paths; reject anything else (relative / garbage).
    if not cwd.startswith("/") and not _WIN_DRIVE_ROOT_RE.match(cwd):
        return False
    # Reject bare filesystem roots ("/" and "C:/").
    if cwd == "/" or _WIN_DRIVE_ROOT_RE.fullmatch(cwd):
        return False
    if is_temp_path(cwd):
        return False
    normalized = os.path.normpath(cwd) + os.sep
    return not normalized.startswith(_flow_records_norm_prefixes())

def _is_valid_project_dir(d: Path) -> bool:
    real = _decode_claude_encoded(d)
    if real is None:
        return False
    return _is_valid_cwd(real)

def _is_valid_mount_path(path: str) -> bool:
    return _is_valid_cwd(path)

def _is_claude_encoded_ref(ref_path: Path) -> bool:
    """Detect Claude provenance by FSRef path structure."""
    parent = ref_path.parent
    return parent.name == "projects" and parent.parent.name == ".claude"

# ── Walker ───────────────────────────────────────────────────────────────────

def _is_temp_encoded(encoded: str) -> bool:
    decoded = "/" + encoded.lstrip("-").replace("-", "/")
    return not _is_valid_cwd(decoded)

def claude_projects_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.fs_store.indexer.functions._claude_projects import decode_claude_project_dir  # noqa: PLC0415
    from flow_sdk.fs_store.scope import Scope  # noqa: PLC0415

    out: list[FSRef] = []
    for node in nodes:
        projects_dir = Path(node.path) / ".claude" / "projects"
        if not projects_dir.is_dir():
            continue
        for child in sorted(projects_dir.iterdir()):
            if not child.is_dir():
                continue
            if not opts.include_temp and _is_temp_encoded(child.name):
                continue
            decoded = decode_claude_project_dir(child)
            out.append(
                FSRef(
                    child,
                    record_type=RecordType.PROJECT,
                    parent=node,
                    scope=Scope.PROJECT.value,
                    project_id=Project.derive_id_for_path(decoded),
                )
            )
    return out

# ── Per-record find / upsert (records_root-scoped, used by extract_*) ────────

def _find_project_record_by_cwd(cwd: str) -> FSRecord | None:
    """Linear scan of records_root/project/ for a record at canonical cwd.

    Cheap (project counts << 1k). Reads metadata.json / data.json directly
    to extract cwd — avoids the polymorphic ``Record.load`` path which
    tries ``object.__setattr__(rec, "cwd", v)`` and chokes on the cwd
    property (no setter). Only when cwd matches do we materialise the
    record via ``Record.load`` (or fall through to direct dict construction).
    """
    if not cwd:
        return None
    canonical = canonical_posix_path(cwd)
    from flow_sdk.fs_store.record_paths import (  # noqa: PLC0415
        _NAME_SEP,
        get_default_records_root,
    )
    _META_JSON = "metadata.json"
    type_dir = get_default_records_root() / RecordType.PROJECT
    if not type_dir.is_dir():
        return None
    for entry in sorted(type_dir.iterdir()):
        if not entry.is_dir() or _NAME_SEP not in entry.name:
            continue
        meta_file = entry / _META_JSON
        data_file = entry / "data" / "_data.json"
        if not meta_file.exists():
            continue
        # Read cwd from data/_data.json without instantiating the record.
        rec_cwd = ""
        if data_file.exists():
            try:
                obj = json.loads(data_file.read_text())
                fields = obj.get("data", obj)
                rec_cwd = fields.get("cwd") or canonical_posix_path(
                    fields.get("real_path") or ""
                )
            except (json.JSONDecodeError, OSError):
                continue
        if rec_cwd != canonical:
            continue
        # Match — construct a base Record from the merged metadata + data
        # without going through the polymorphic setattr loop.
        try:
            meta = json.loads(meta_file.read_text()).get("data", {})
            data = json.loads(data_file.read_text()).get("data", {}) if data_file.exists() else {}
            merged = {**meta, **data}
            rec = FSRecord(**merged)
            object.__setattr__(rec, "_source_file", str(meta_file))
            object.__setattr__(rec, "_path", str(entry))
            return rec
        except (json.JSONDecodeError, OSError, ValueError):
            continue
    return None

def _compute_project_session_stats(rec: Record) -> tuple[int, str | None]:
    """Walk Claude + Codex on-disk session sources and return aggregate
    ``(session_count, last_session_at)`` for this record's cwd."""
    total = 0
    last_ts: str | None = None

    def _bump(ts: float) -> None:
        nonlocal last_ts
        iso = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        if last_ts is None or iso > last_ts:
            last_ts = iso

    is_claude = bool(getattr(rec, "claude_project", False))
    is_codex = bool(getattr(rec, "codex_project", False))
    encoded = getattr(rec, "encoded_path", None) or ""
    cwd = getattr(rec, "cwd", None) or ""

    if is_claude:
        project_dir: Path | None = None
        ar = getattr(rec, "asset_ref", None)
        path_attr = ar.path if ar is not None else None
        if path_attr:
            cand = Path(path_attr)
            if cand.is_dir():
                project_dir = cand
        if project_dir is None and encoded:
            cand = _claude_projects_dir() / encoded
            if cand.is_dir():
                project_dir = cand
        if project_dir is not None:
            for f in project_dir.glob("*.jsonl"):
                total += 1
                try:
                    _bump(f.stat().st_mtime)
                except OSError:
                    continue

    if is_codex and cwd:
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
        sessions_root = get_instance_settings().codex_sessions_dir
        if sessions_root.is_dir():
            for p in sessions_root.rglob("rollout-*.jsonl"):
                try:
                    with open(p, "rb") as fh:
                        head = fh.read(8192).decode("utf-8", errors="replace")
                except OSError:
                    continue
                matched = False
                for line in head.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        raw = json.loads(line)
                    except json.JSONDecodeError:
                        break
                    if raw.get("type") == "session_meta":
                        payload = raw.get("payload") or {}
                        if payload.get("cwd") == cwd:
                            matched = True
                        break
                if matched:
                    total += 1
                    try:
                        _bump(p.stat().st_mtime)
                    except OSError:
                        continue

    return total, last_ts

async def _refresh_session_stats_and_save(rec: FSRecord) -> FSRecord:
    """Recompute denormalized session stats onto ``rec`` and persist it.

    A project is an aggregate with no single source file, so its real
    "last modified" is the most-recent child session activity — stamp that as
    ``updated_date`` (when any sessions exist) so ``from_record`` preserves it
    instead of falling back to the index instant. Childless projects keep the
    now() fallback.
    """
    session_count, last_session_at = _compute_project_session_stats(rec)
    rec.session_count = session_count
    rec.last_session_at = last_session_at
    if last_session_at:
        rec.updated_date = last_session_at
    try:
        await rec.save()
    except Exception:
        pass
    return rec

async def _upsert_project_for_cwd(
    cwd: str,
    *,
    claude_project: bool | None = None,
    codex_project: bool | None = None,
    encoded_path: str | None = None,
) -> FSRecord:
    """Find existing project record by cwd or create a fresh one. Refresh
    denormalized session-stat fields. Saves to disk. Returns the Record.
    """
    canonical = canonical_posix_path(cwd)
    existing = _find_project_record_by_cwd(canonical)
    if existing is not None:
        if claude_project is not None:
            existing.claude_project = claude_project
        if codex_project is not None:
            existing.codex_project = codex_project
        if encoded_path and not existing.data.get("encoded_path"):
            existing.encoded_path = encoded_path
        if not existing.data.get("cwd"):
            object.__setattr__(existing, "cwd", canonical)
        object.__setattr__(existing, "last_indexed_at", _now_iso())
        return await _refresh_session_stats_and_save(existing)

    # Fresh — construct a base Record with a uuid4 id.
    # Project ids are uuid4, NOT uuid5-derived (uuid5 is used only for the
    # dedup key returned by claude_project_id / genId_fn).
    kwargs: dict = {
        "type": RecordType.PROJECT,
        "id": str(uuid.uuid4()),
        "cwd": canonical,
        "claude_project": bool(claude_project),
        "codex_project": bool(codex_project),
        "last_indexed_at": _now_iso(),
        "name": canonical,
    }
    if encoded_path:
        kwargs["encoded_path"] = encoded_path
    rec = FSRecord(**kwargs)
    return await _refresh_session_stats_and_save(rec)

# ── async parser_fn + getId ──────────────────────────────────────────────────

def claude_project_id(ref: FSRef) -> str:
    """Deterministic dedup key keyed on canonical cwd.

    Matches the deleted ``ProjectFsRecord.getId`` — used by the indexer's
    per-FSRef cache BEFORE extract_claude_project is invoked. The persisted
    record's id remains a uuid4 (set explicitly in _upsert_project_for_cwd).
    """
    ref_path = Path(ref._path)
    if _is_claude_encoded_ref(ref_path):
        real = _decode_claude_encoded(ref_path)
        cwd_key = real or str(ref_path)
    else:
        cwd_key = str(ref_path)
    cwd_key = canonical_posix_path(cwd_key) if cwd_key else str(ref_path)
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"project-fsref:{cwd_key}"))

async def extract_claude_project(ref: FSRef) -> list[FSRecord]:
    """Async parser_fn — upsert by canonical cwd. Replaces
    the deleted ``ProjectFsRecord.from_fsref``."""
    ref_path = Path(ref._path)
    if _is_claude_encoded_ref(ref_path):
        real = _decode_claude_encoded(ref_path)
        if real is None or not _is_valid_cwd(real):
            return []
        rec = await _upsert_project_for_cwd(
            real, claude_project=True, encoded_path=ref_path.name,
        )
        return [rec]
    ref_str = str(ref_path)
    if not _is_valid_cwd(ref_str):
        return []
    rec = await _upsert_project_for_cwd(ref_str, codex_project=True)
    return [rec]
