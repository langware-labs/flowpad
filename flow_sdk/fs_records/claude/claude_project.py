"""ClaudeProjectFsRecord — represents a Claude Code project directory.

Two discovery sources are merged:

1. ``records_root/project/`` — projects created via the API (POST /graph/project)
2. ``~/.claude/projects/<encoded-path>/`` — projects opened by Claude CLI

Both sources are surfaced by ``discover()`` (id-based dedup) and looked up
O(1) by ``get()``.
"""

from __future__ import annotations

import json
import os
import shutil
import uuid
from pathlib import Path
from typing import ClassVar

from flow_sdk.fs_store import Record, RecordType
from .claude_session import ClaudeSessionRecord

_CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"
_TEMP_PATH_PREFIXES = ("/tmp/", "/var/folders/", "/private/var/folders/", "/private/tmp/")
_HOME_STR: str = str(Path.home())
# Prefixes (applied to os.path.normpath(mount_path)) that identify system artifacts.
# The stored paths use a buggy double-slash form (/Users/foo//flow/records/...) which
# normpath collapses to /Users/foo/flow/records/... — so we check both variants.
_FLOW_RECORDS_NORM_PREFIXES: tuple[str, ...] = (
    _HOME_STR + "/.flow/records/",
    _HOME_STR + "/flow/records/",
)


def _project_id(encoded: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"project:{encoded}"))


class ClaudeProjectFsRecord(Record):
    """A Claude Code project — a working directory with associated sessions.

    Backed by either ``records_root/project/`` (API-created) or
    ``~/.claude/projects/<encoded-cwd>/`` (Claude CLI-created).
    """

    _record_type: ClassVar[str] = RecordType.PROJECT
    _indexed_by_default: ClassVar[bool] = True

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.PROJECT
        super().__init__(**kwargs)
        encoded_path = self.data.get("encoded_path", "")
        if encoded_path:
            if not self.name:
                self.name = self.data.get("real_path", "") or encoded_path
            # External-source records (from ~/.claude/projects/) are read-only;
            # records_root records (API-created, no encoded_path) are writable.
            from flow_sdk.fs_store.fs_ref import FSRef
            object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    @property
    def search_title(self) -> str | None:
        return self.name or None

    @property
    def search_description(self) -> str | None:
        return self.data.get("real_path") or None

    @property
    def session_count(self) -> int:
        """Count of JSONL session files under this project's ``~/.claude/projects/`` dir.

        Works for both discovery sources: Phase 2 records carry ``_path`` pointing at the
        project dir; Phase 1 records_root records carry ``encoded_path`` and we resolve
        it against ``_CLAUDE_PROJECTS_DIR``. Returns 0 when no session dir exists.
        """
        project_dir: Path | None = None
        path_attr = getattr(self, "_path", None) or self.source_file
        if path_attr:
            candidate = Path(path_attr)
            if candidate.is_dir():
                project_dir = candidate
        if project_dir is None:
            encoded = self.data.get("encoded_path") or ""
            if encoded:
                candidate = _CLAUDE_PROJECTS_DIR / encoded
                if candidate.is_dir():
                    project_dir = candidate
        if project_dir is None:
            return 0
        return sum(1 for _ in project_dir.glob("*.jsonl"))

    @property
    def sessions(self) -> list[ClaudeSessionRecord]:
        """Return all sessions in this project as ``ClaudeSessionRecord``."""
        project_dir = Path(self.path or self.source_file) if (self.path or self.source_file) else None
        if not project_dir or not project_dir.is_dir():
            return []
        return [
            ClaudeSessionRecord.from_jsonl(f)
            for f in sorted(project_dir.glob("*.jsonl"))
        ]

    # -- External source: ~/.claude/projects/ --

    @classmethod
    def _is_valid_project_dir(cls, d: Path) -> bool:
        real = "/" + d.name.lstrip("-").replace("-", "/")
        return not real.startswith(_TEMP_PATH_PREFIXES)

    @classmethod
    def _is_valid_mount_path(cls, path: str) -> bool:
        """Return False for system/temp paths that should never appear as user projects."""
        if path.startswith(_TEMP_PATH_PREFIXES):
            return False
        normalized = os.path.normpath(path) + os.sep
        return not normalized.startswith(_FLOW_RECORDS_NORM_PREFIXES)

    @classmethod
    def _from_claude_dir(cls, d: Path) -> "ClaudeProjectFsRecord":
        encoded = d.name
        real = "/" + encoded.lstrip("-").replace("-", "/")
        session_count = sum(1 for f in d.glob("*.jsonl"))
        return cls(
            id=_project_id(encoded),
            encoded_path=encoded,
            real_path=real,
            session_count=session_count,
            path=str(d),
        )

    @classmethod
    async def from_fsref(cls, ref) -> list["ClaudeProjectFsRecord"]:
        """Indexer entry point — construct from an FSRef emitted by claude_projects_fn."""
        return [cls._from_claude_dir(ref._path)]

    @classmethod
    def getId(cls, ref) -> str:
        """Id = `_project_id(encoded_name)` = uuid5(DNS, "project:<encoded>").

        Matches `_from_claude_dir` which sets `self.id = _project_id(encoded)`.
        Uses DNS namespace + encoded-name prefix (NOT the path-based default)."""
        import uuid
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"project:{ref._path.name}"))

    @classmethod
    def discover(cls, scope=None, **kwargs) -> list["ClaudeProjectFsRecord"]:
        """Discover projects from records_root and ``~/.claude/projects/``.

        Skips records_root projects whose ``fs_storage_mount_path`` points at a
        system/temp location (e.g. agentic process output dirs). External-source
        entries from ``~/.claude/projects/`` are filtered via ``_is_valid_project_dir``.
        """
        from flow_sdk.fs_store.record import get_default_records_root, _NAME_SEP, _META_JSON, _migrate_old_format  # noqa: PLC0415
        import json as _json  # noqa: PLC0415

        record_type = str(getattr(cls, "_record_type", ""))
        limit = kwargs.get("limit")
        results: list[ClaudeProjectFsRecord] = []
        seen_ids: set[str] = set()

        # Phase 1: records_root — filter out system-path garbage projects
        type_dir = get_default_records_root() / record_type
        if type_dir.is_dir():
            for entry in sorted(type_dir.iterdir()):
                if not entry.is_dir() or _NAME_SEP not in entry.name:
                    continue
                meta_file = entry / _META_JSON
                if not meta_file.exists() and _migrate_old_format(entry) is None:
                    continue
                mount_path = cls._read_mount_path(entry)
                if mount_path and not cls._is_valid_mount_path(mount_path):
                    continue
                try:
                    rec = cls.load_record(entry)
                    seen_ids.add(rec.id)
                    results.append(rec)
                    if limit is not None and len(results) >= limit:
                        return results
                except (_json.JSONDecodeError, OSError, ValueError):
                    continue

        # Phase 2: ~/.claude/projects/ (deduped by id)
        projects_dir = _CLAUDE_PROJECTS_DIR
        if projects_dir.is_dir():
            for d in sorted(projects_dir.iterdir()):
                if not d.is_dir() or not cls._is_valid_project_dir(d):
                    continue
                rec = cls._from_claude_dir(d)
                if rec.id in seen_ids:
                    continue
                seen_ids.add(rec.id)
                results.append(rec)
                if limit is not None and len(results) >= limit:
                    return results

        return results

    @classmethod
    async def clean_temp_projects(cls) -> int:
        """Remove temp-path project entries from both discovery sources and the DB index.

        Source 1: ``~/.claude/projects/<encoded>/`` — identified via encoded dir name.
        Source 2: ``records_root/project/<dir>/`` — identified via fs_storage_mount_path
                  in metadata.json.

        Returns the total number of directories removed.
        """
        removed = 0

        # Source 1: ~/.claude/projects/
        projects_dir = _CLAUDE_PROJECTS_DIR
        if projects_dir.is_dir():
            for d in list(projects_dir.iterdir()):
                if d.is_dir() and not cls._is_valid_project_dir(d):
                    rec = cls._from_claude_dir(d)
                    await rec.unindex()
                    shutil.rmtree(d, ignore_errors=True)
                    removed += 1

        # Source 2: records_root/project/
        from flow_sdk.fs_store.record import get_default_records_root
        records_project_dir = get_default_records_root() / RecordType.PROJECT
        if records_project_dir.is_dir():
            for d in list(records_project_dir.iterdir()):
                if not d.is_dir():
                    continue
                mount_path = cls._read_mount_path(d)
                if mount_path and not cls._is_valid_mount_path(mount_path):
                    try:
                        rec = cls.load_record(d)
                        await rec.unindex()
                    except Exception:
                        pass
                    shutil.rmtree(d, ignore_errors=True)
                    removed += 1

        return removed

    @classmethod
    def _read_mount_path(cls, record_dir: Path) -> str | None:
        """Read fs_storage_mount_path from a records_root project directory."""
        for filename, key in (("metadata.json", "data"), ("state.json", "meta")):
            f = record_dir / filename
            if f.exists():
                try:
                    obj = json.loads(f.read_text())
                    return obj.get(key, {}).get("fs_storage_mount_path")
                except Exception:
                    pass
        return None

    @classmethod
    def get(cls, uid: str, **kwargs) -> "ClaudeProjectFsRecord | None":
        """Find a Claude-project record by UUID: records_root first, then ~/.claude/projects/."""
        rec = super().get(uid, **kwargs)
        if rec is not None:
            return rec
        projects_dir = _CLAUDE_PROJECTS_DIR
        if not projects_dir.is_dir():
            return None
        for d in projects_dir.iterdir():
            if not d.is_dir() or not cls._is_valid_project_dir(d):
                continue
            if _project_id(d.name) == uid:
                return cls._from_claude_dir(d)
        return None
