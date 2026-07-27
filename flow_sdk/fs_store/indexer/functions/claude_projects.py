"""Walker + async extractor + helpers for PROJECT records.

Both Claude and Codex indexer paths converge on this single record type by
canonical posix cwd. The parser_fn (``extract_claude_project``) is **async**
because it does real disk I/O during upsert-by-cwd (session-stat counts +
DB save) — this is the only async parser_fn in the indexer today.

Replaces the parse-side behaviour of the deleted ``ProjectFsRecord`` subclass.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from flow_sdk.fs_store import RecordType
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.path_utils import canonical_posix_path, is_valid_project_cwd

# ── Helpers (moved from ProjectFsRecord) ─────────────────────────────────────


def _claude_projects_dir() -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().claude_projects_dir


def _decode_claude_encoded(d: Path) -> str | None:
    from flow_sdk.fs_store.indexer.functions._claude_projects import decode_claude_project_dir  # noqa: PLC0415

    real = decode_claude_project_dir(d)
    if real is None:
        return None
    return str(real)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _is_claude_encoded_ref(ref_path: Path) -> bool:
    """Detect Claude provenance by FSRef path structure."""
    parent = ref_path.parent
    return parent.name == "projects" and parent.parent.name == ".claude"


# ── Walker ───────────────────────────────────────────────────────────────────


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
            decoded = decode_claude_project_dir(child)
            if decoded is None or not is_valid_project_cwd(
                decoded,
                include_temp=opts.include_temp,
            ):
                continue
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
    """Return the first ID-sorted project record matching canonical ``cwd``."""
    if not cwd:
        return None
    canonical = canonical_posix_path(cwd)
    records = sorted(
        FSRecord.discover(RecordType.PROJECT),
        key=lambda record: str(record.id or ""),
    )
    for record in records:
        candidates = (
            getattr(record, "cwd", None),
            getattr(record, "fs_storage_mount_path", None),
            getattr(record, "real_path", None),
        )
        if any(value and canonical_posix_path(str(value)) == canonical for value in candidates):
            return record
        name = getattr(record, "name", None)
        if name and Path(str(name)).is_absolute():
            if canonical_posix_path(str(name)) == canonical:
                return record
    return None


def _compute_project_session_stats(rec: FSRecord) -> tuple[int, str | None]:
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
    resolved_id: str,
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
        existing.id = resolved_id
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

    # Fresh filesystem-record identity was resolved centrally by TypeInfo.
    # The shareable Project entity keeps its separate opaque-v4 policy.
    kwargs: dict = {
        "type": RecordType.PROJECT,
        "id": resolved_id,
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


# ── Identity reader/key + async parser_fn ────────────────────────────────────


def _canonical_project_cwd(ref: FSRef | Path) -> str:
    """Resolve a direct cwd or Claude-encoded ref to one canonical cwd."""
    ref_path = Path(getattr(ref, "_path", ref))
    if _is_claude_encoded_ref(ref_path):
        resolved = _decode_claude_encoded(ref_path)
        cwd = str(resolved) if resolved is not None else str(ref_path)
    else:
        cwd = str(ref_path)
    return canonical_posix_path(cwd) if cwd else str(ref_path)


def claude_project_identity_key(ref: FSRef | Path) -> str:
    """Stable v5 key for the filesystem project record, keyed by cwd."""
    return f"project-fsref:{_canonical_project_cwd(ref)}"


def existing_project_record_id(ref: FSRef | Path) -> str | None:
    """Read an existing filesystem project-record id without minting."""
    record = _find_project_record_by_cwd(_canonical_project_cwd(ref))
    return str(record.id) if record is not None and record.id is not None else None


async def extract_claude_project(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Async parser_fn — upsert by canonical cwd. Replaces
    the deleted ``ProjectFsRecord.from_fsref``."""
    ref_path = Path(ref._path)
    if _is_claude_encoded_ref(ref_path):
        real = _decode_claude_encoded(ref_path)
        if real is None or not is_valid_project_cwd(real):
            return []
        rec = await _upsert_project_for_cwd(
            real,
            resolved_id=resolved_id,
            claude_project=True,
            encoded_path=ref_path.name,
        )
        return [rec]
    ref_str = str(ref_path)
    if not is_valid_project_cwd(ref_str):
        return []
    rec = await _upsert_project_for_cwd(ref_str, resolved_id=resolved_id, codex_project=True)
    return [rec]
