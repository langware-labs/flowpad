"""CodexProjectFsRecord — represents a project Codex CLI knows about.

Two discovery sources are merged:

1. ``$CODEX_HOME/config.toml`` ``[projects."<absolute-path>"]`` keys — the
   authoritative list, includes ``trust_level``.
2. ``session_meta.payload.cwd`` aggregated from rollout JSONL files — covers
   projects Codex used but never marked trusted (e.g. one-shot runs).

Both sources are dedup'd by id (``uuid5(DNS, "codex_project:<absolute>")``).
Read-only: ``config.toml`` and rollouts are owned by Codex; we never write.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import ClassVar

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.instance_settings import get_instance_settings

from .codex_session import CodexSessionRecord

try:  # Python 3.11+
    import tomllib as _tomllib  # type: ignore[import-not-found]
except ImportError:  # Python 3.10 — repo includes tomli in venv.
    import tomli as _tomllib  # type: ignore[import-not-found,no-redef]


_TEMP_PATH_PREFIXES = (
    "/tmp/",
    "/var/folders/",
    "/private/var/folders/",
    "/private/tmp/",
)


def _codex_project_id(cwd: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"codex_project:{cwd}"))


def _is_valid_cwd(cwd: str) -> bool:
    """Filter out system/temp paths that should never appear as user projects."""
    if not cwd or not cwd.startswith("/"):
        return False
    return not cwd.startswith(_TEMP_PATH_PREFIXES)


def _read_codex_projects_from_config(config_path: Path) -> dict[str, dict]:
    """Return ``{absolute_path: {trust_level}}`` from ``config.toml``."""
    if not config_path.is_file():
        return {}
    try:
        with open(config_path, "rb") as fh:
            data = _tomllib.load(fh)
    except (OSError, ValueError):
        return {}
    projects = data.get("projects")
    if not isinstance(projects, dict):
        return {}
    out: dict[str, dict] = {}
    for path, entry in projects.items():
        if not isinstance(path, str) or not _is_valid_cwd(path):
            continue
        if isinstance(entry, dict):
            out[path] = {"trust_level": entry.get("trust_level")}
        else:
            out[path] = {"trust_level": None}
    return out


def _scan_rollout_meta(jsonl_path: Path) -> dict | None:
    """Return ``{cwd, originator, modified_at}`` from a rollout's session_meta line.

    Reads at most the first 8 KB; returns None on parse failure.
    """
    try:
        with open(jsonl_path, "rb") as fh:
            head = fh.read(8192).decode("utf-8", errors="replace")
    except OSError:
        return None
    for line in head.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            return None
        if raw.get("type") == "session_meta":
            payload = raw.get("payload") or {}
            cwd = payload.get("cwd")
            if not isinstance(cwd, str) or not _is_valid_cwd(cwd):
                return None
            try:
                from datetime import datetime as _dt
                mtime = _dt.fromtimestamp(jsonl_path.stat().st_mtime).isoformat()
            except OSError:
                mtime = None
            return {
                "cwd": cwd,
                "originator": payload.get("originator") or "",
                "modified_at": mtime,
            }
    return None


class CodexProjectFsRecord(Record):
    """A Codex CLI project — a working directory with associated rollout sessions."""

    _record_type: ClassVar[str] = RecordType.CODEX_PROJECT
    _indexed_by_default: ClassVar[bool] = True

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CODEX_PROJECT
        super().__init__(**kwargs)
        cwd = self.data.get("cwd") or kwargs.get("cwd") or ""
        if cwd and not self.name:
            self.name = cwd
        # External source — config.toml/rollouts owned by Codex.
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    @property
    def search_title(self) -> str | None:
        return self.name or None

    @property
    def search_description(self) -> str | None:
        return self.data.get("cwd") or None

    @property
    def cwd(self) -> str:
        return self.data.get("cwd") or ""

    @property
    def trust_level(self) -> str | None:
        return self.data.get("trust_level")

    @property
    def originators(self) -> list[str]:
        return list(self.data.get("originators") or [])

    @property
    def session_count(self) -> int:
        return len(self._matching_rollout_paths())

    @property
    def sessions(self) -> list[CodexSessionRecord]:
        out: list[CodexSessionRecord] = []
        for p in self._matching_rollout_paths():
            try:
                out.append(CodexSessionRecord.from_jsonl(p))
            except (json.JSONDecodeError, OSError):
                continue
        return out

    def _matching_rollout_paths(self) -> list[Path]:
        sessions_root = get_instance_settings().codex_sessions_dir
        if not sessions_root.is_dir():
            return []
        target = self.cwd
        if not target:
            return []
        out: list[Path] = []
        for p in sessions_root.rglob("rollout-*.jsonl"):
            meta = _scan_rollout_meta(p)
            if meta and meta.get("cwd") == target:
                out.append(p)
        return out

    # ── Discovery ─────────────────────────────────────────────────────────────

    @classmethod
    def _from_cwd(
        cls,
        cwd: str,
        *,
        trust_level: str | None = None,
        originators: list[str] | None = None,
        latest_activity: str | None = None,
    ) -> "CodexProjectFsRecord":
        return cls(
            id=_codex_project_id(cwd),
            cwd=cwd,
            trust_level=trust_level,
            originators=originators or [],
            latest_activity=latest_activity,
        )

    @classmethod
    async def from_fsref(cls, ref) -> list["CodexProjectFsRecord"]:
        """Indexer entry — construct a single record from the cwd path.

        The codex_projects_fn expander emits one FSRef per absolute cwd, so
        we simply build the record. Trust level is read from config.toml on
        each call (cheap — a single file parse), keeping per-record state
        consistent with full discovery.
        """
        cwd = str(ref._path)
        if not _is_valid_cwd(cwd):
            return []
        settings = get_instance_settings()
        cfg = _read_codex_projects_from_config(settings.codex_config_path)
        trust_level = (cfg.get(cwd) or {}).get("trust_level")
        return [cls._from_cwd(cwd, trust_level=trust_level)]

    @classmethod
    def getId(cls, ref) -> str:
        return _codex_project_id(str(ref._path))

    @classmethod
    def discover(cls, scope=None, **kwargs) -> list["CodexProjectFsRecord"]:
        """Discover projects from config.toml and rollout session_meta cwds."""
        settings = get_instance_settings()
        results = cls._discover_merged(
            config_path=settings.codex_config_path,
            sessions_root=settings.codex_sessions_dir,
        )
        limit = kwargs.get("limit")
        if limit is not None:
            return results[:limit]
        return results

    @classmethod
    def _discover_merged(
        cls, *, config_path: Path, sessions_root: Path
    ) -> list["CodexProjectFsRecord"]:
        # Phase 1: config.toml — authoritative project list with trust level.
        from_config = _read_codex_projects_from_config(config_path)

        # Phase 2: walk rollouts to pick up projects not in config + activity.
        cwd_to_meta: dict[str, dict] = {}
        if sessions_root.is_dir():
            for p in sessions_root.rglob("rollout-*.jsonl"):
                meta = _scan_rollout_meta(p)
                if not meta:
                    continue
                cwd = meta["cwd"]
                bucket = cwd_to_meta.setdefault(
                    cwd,
                    {"originators": set(), "latest_activity": None},
                )
                if meta.get("originator"):
                    bucket["originators"].add(meta["originator"])
                ts = meta.get("modified_at")
                if ts and (
                    not bucket["latest_activity"] or ts > bucket["latest_activity"]
                ):
                    bucket["latest_activity"] = ts

        all_cwds: set[str] = set(from_config) | set(cwd_to_meta)
        out: list[CodexProjectFsRecord] = []
        seen_ids: set[str] = set()
        for cwd in sorted(all_cwds):
            if not _is_valid_cwd(cwd):
                continue
            cfg = from_config.get(cwd) or {}
            meta = cwd_to_meta.get(cwd) or {}
            originators = sorted(meta.get("originators") or [])
            rec = cls._from_cwd(
                cwd,
                trust_level=cfg.get("trust_level"),
                originators=originators,
                latest_activity=meta.get("latest_activity"),
            )
            if rec.id in seen_ids:
                continue
            seen_ids.add(rec.id)
            out.append(rec)
        # Sort by latest_activity desc; projects without activity go last.
        out.sort(
            key=lambda r: (r.data.get("latest_activity") or ""),
            reverse=True,
        )
        return out

    @classmethod
    def get(cls, uid: str, **kwargs) -> "CodexProjectFsRecord | None":
        """Find a Codex-project record by uuid5 id."""
        for rec in cls.discover():
            if rec.id == uid:
                return rec
        return None
