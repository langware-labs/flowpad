"""ProjectFsRecord — single record type for any project directory.

Represents a project working directory regardless of provenance. Both Claude
and Codex indexer functions converge on this single record by **canonical
posix cwd**, with provenance flags marking which source(s) saw the path:

    rec.cwd              — canonical posix path (the natural key, unique)
    rec.claude_project   — Claude has session data at this cwd
    rec.codex_project    — Codex has session data at this cwd
    rec.last_indexed_at  — timestamp of the most recent indexer pass

The id is a random ``uuid4`` and is **not** derived from the path. Lookup
happens via :py:meth:`find_by_cwd` and create-or-update via
:py:meth:`upsert_for_cwd`. The id is stable once assigned but is opaque.

``ClaudeProjectFsRecord`` is kept as a backward-compat alias.
"""

from __future__ import annotations

import json
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import ClassVar

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.path_utils import canonical_posix_path
from .claude_session import ClaudeSessionRecord

_TEMP_PATH_PREFIXES = ("/tmp/", "/var/folders/", "/private/var/folders/", "/private/tmp/")


def _claude_projects_dir() -> Path:
    """Per-instance ~/.claude/projects (call-time, via InstanceSettings)."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    return get_instance_settings().claude_projects_dir


def _flow_records_norm_prefixes() -> tuple[str, ...]:
    """Prefixes (against os.path.normpath of mount_path) identifying system artifacts."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    home_str = str(get_instance_settings().user_home)
    return (
        home_str + "/.flow/records/",
        home_str + "/flow/records/",
    )


def _decode_claude_encoded(d: Path) -> str | None:
    """Decode a Claude-encoded project dir name into a real path string.

    Lazy-imports the canonical decoder to avoid circular import via
    ``flow_sdk.fs_records._claude_projects``.
    """
    from flow_sdk.fs_records._claude_projects import decode_claude_project_dir  # noqa: PLC0415
    real = decode_claude_project_dir(d)
    if real is None:
        return None
    return str(real)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class ProjectFsRecord(Record):
    """A project directory (one record per canonical cwd).

    Provenance flags (``claude_project``, ``codex_project``) capture which
    indexer source(s) have observed this cwd. Both can be true. The ID is a
    random uuid4 — fetch by ``cwd`` (the natural key), not by id derivation.
    """

    _record_type: ClassVar[str] = RecordType.PROJECT
    _indexed_by_default: ClassVar[bool] = True

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.PROJECT
        # Force uuid4: do NOT let the base class derive an identity-key uuid5.
        if "id" not in kwargs:
            kwargs["id"] = str(uuid.uuid4())
        super().__init__(**kwargs)
        # Display name fallback: cwd or legacy real_path.
        cwd = self.data.get("cwd") or self.data.get("real_path") or kwargs.get("cwd")
        if cwd and not self.name:
            self.name = cwd
        # records_root-backed records are writable; external-source records
        # (constructed in-memory from ~/.claude/projects/) carry a read-only ref.
        if kwargs.get("_external_source"):
            from flow_sdk.fs_store.fs_ref import FSRef
            object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    # ─── Properties ────────────────────────────────────────────────────────

    @property
    def search_title(self) -> str | None:
        return self.name or None

    @property
    def search_description(self) -> str | None:
        return self.cwd or self.data.get("real_path") or None

    @property
    def cwd(self) -> str:
        """Canonical posix path. Falls back to canonical(real_path) for legacy rows."""
        cwd = self.data.get("cwd")
        if cwd:
            return cwd
        real = self.data.get("real_path")
        if real:
            return canonical_posix_path(real)
        return ""

    @property
    def is_claude_project(self) -> bool:
        return bool(self.data.get("claude_project"))

    @property
    def is_codex_project(self) -> bool:
        return bool(self.data.get("codex_project"))

    # NOTE: ``last_indexed_at``, ``session_count``, and ``last_session_at`` are
    # plain data fields persisted on ``__dict__`` and surfaced via Python's
    # attribute lookup against the dict (no ``@property`` accessor). The old
    # live disk-walking ``session_count`` / ``claude_session_count`` /
    # ``codex_session_count`` properties were removed when the consolidation
    # moved to denormalization at upsert time (Path A 2026-05-09). The
    # disk-walking logic now lives in ``_compute_session_stats``.

    @property
    def sessions(self) -> list[ClaudeSessionRecord]:
        """Claude-side sessions (legacy convenience — was Claude-only)."""
        if not self.is_claude_project:
            return []
        project_dir = Path(self.path or self.source_file) if (self.path or self.source_file) else None
        if project_dir is None:
            encoded = self.data.get("encoded_path") or ""
            if encoded:
                candidate = _claude_projects_dir() / encoded
                if candidate.is_dir():
                    project_dir = candidate
        if project_dir is None or not project_dir.is_dir():
            return []
        return [
            ClaudeSessionRecord.from_jsonl(f)
            for f in sorted(project_dir.glob("*.jsonl"))
        ]

    # ─── Validation ────────────────────────────────────────────────────────

    @classmethod
    def _is_valid_cwd(cls, cwd: str) -> bool:
        """Reject system/temp paths."""
        if not cwd or not cwd.startswith("/"):
            return False
        if cwd == "/":
            return False
        temp_roots = tuple(prefix.rstrip("/") for prefix in _TEMP_PATH_PREFIXES)
        if cwd in temp_roots or cwd.startswith(_TEMP_PATH_PREFIXES):
            return False
        normalized = os.path.normpath(cwd) + os.sep
        return not normalized.startswith(_flow_records_norm_prefixes())

    @classmethod
    def _is_valid_project_dir(cls, d: Path) -> bool:
        """Backward-compat: callers checking a Claude-encoded dir."""
        real = _decode_claude_encoded(d)
        if real is None:
            return False
        return cls._is_valid_cwd(real)

    @classmethod
    def _is_valid_mount_path(cls, path: str) -> bool:
        """Backward-compat: same as ``_is_valid_cwd`` over a mount-path string."""
        return cls._is_valid_cwd(path)

    # ─── Lookup / upsert (the new API) ─────────────────────────────────────

    @classmethod
    def find_by_cwd(cls, cwd: str) -> "ProjectFsRecord | None":
        """Find a record at the given canonical cwd in records_root.

        Scans ``records_root/project/`` linearly; cheap because project counts
        are small (<<1k). Falls back to canonicalising legacy rows whose
        ``cwd`` field is empty but ``real_path`` is set.
        """
        if not cwd:
            return None
        canonical = canonical_posix_path(cwd)
        from flow_sdk.fs_store.record import (  # noqa: PLC0415
            get_default_records_root,
            _NAME_SEP,
            _META_JSON,
            _migrate_old_format,
        )
        type_dir = get_default_records_root() / RecordType.PROJECT
        if not type_dir.is_dir():
            return None
        for entry in sorted(type_dir.iterdir()):
            if not entry.is_dir() or _NAME_SEP not in entry.name:
                continue
            meta_file = entry / _META_JSON
            if not meta_file.exists() and _migrate_old_format(entry) is None:
                continue
            try:
                rec = cls.load_record(entry)
            except (json.JSONDecodeError, OSError, ValueError):
                continue
            if rec.cwd == canonical:
                return rec
        return None

    @classmethod
    async def upsert_for_cwd(
        cls,
        cwd: str,
        *,
        claude_project: bool | None = None,
        codex_project: bool | None = None,
        encoded_path: str | None = None,
    ) -> "ProjectFsRecord":
        """Find or create a project record at the given cwd.

        Existing rows have their flags merged (only updates when the incoming
        flag is not None). ``last_indexed_at`` always refreshes. Session-count
        denormalization fields (``session_count``, ``last_session_at``) are
        recomputed from disk on every upsert so that the matching Project
        entity (created/updated via ``sync_to_db`` → ``Project.from_record``)
        gets fresh activity hints without the entity layer touching records.

        Note: ``Record.data`` is a read-only property returning a copy of
        ``to_dict()`` — write via direct attribute assignment so the values
        actually persist on ``__dict__``.
        """
        canonical = canonical_posix_path(cwd)
        existing = cls.find_by_cwd(canonical)
        if existing is not None:
            if claude_project is not None:
                existing.claude_project = claude_project
            if codex_project is not None:
                existing.codex_project = codex_project
            if encoded_path and not existing.data.get("encoded_path"):
                existing.encoded_path = encoded_path
            # ``cwd`` and ``last_indexed_at`` are exposed via @property, so use
            # ``object.__setattr__`` to write the underlying ``__dict__`` value
            # the property reads from (via ``data``/``to_dict`` chain).
            if not existing.data.get("cwd"):
                object.__setattr__(existing, "cwd", canonical)
            object.__setattr__(existing, "last_indexed_at", _now_iso())
            # Denormalized session-stats are plain data fields (no @property);
            # direct attribute assignment writes ``__dict__`` cleanly.
            session_count, last_session_at = existing._compute_session_stats()
            existing.session_count = session_count
            existing.last_session_at = last_session_at
            try:
                await existing.save()
            except Exception:
                pass
            return existing

        # Create fresh — kwargs flow through Record.__init__ into __dict__.
        kwargs = {
            "cwd": canonical,
            "claude_project": bool(claude_project),
            "codex_project": bool(codex_project),
            "last_indexed_at": _now_iso(),
            "name": canonical,
        }
        if encoded_path:
            kwargs["encoded_path"] = encoded_path
        rec = cls(**kwargs)
        # Populate session-stats denormalization on the fresh record so the
        # subsequent ``sync_to_db`` propagates them onto the Project entity.
        session_count, last_session_at = rec._compute_session_stats()
        rec.session_count = session_count
        rec.last_session_at = last_session_at
        try:
            await rec.save()
        except Exception:
            pass
        return rec

    def _compute_session_stats(self) -> tuple[int, str | None]:
        """Walk Claude + Codex on-disk session sources and return aggregate
        ``(session_count, last_session_at)`` for this record's ``cwd``.

        Called by ``upsert_for_cwd`` to populate the denormalized fields the
        entity layer surfaces. Cheap-but-bounded I/O — at most a few file
        stats per session JSONL, plus one rglob per provider per cwd.
        """
        from datetime import datetime as _dt  # noqa: PLC0415

        total = 0
        last_ts: str | None = None

        def _bump(ts: float) -> None:
            nonlocal last_ts
            iso = _dt.fromtimestamp(ts, tz=timezone.utc).isoformat()
            if last_ts is None or iso > last_ts:
                last_ts = iso

        # Claude side: ``~/.claude/projects/<encoded>/<session>.jsonl``
        if self.is_claude_project:
            encoded = self.data.get("encoded_path") or ""
            project_dir: Path | None = None
            path_attr = getattr(self, "_path", None) or self.source_file
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

        # Codex side: rollouts whose ``session_meta.payload.cwd`` equals our cwd.
        if self.is_codex_project:
            from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

            sessions_root = get_instance_settings().codex_sessions_dir
            target = self.cwd
            if sessions_root.is_dir() and target:
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
                            if payload.get("cwd") == target:
                                matched = True
                            break
                    if matched:
                        total += 1
                        try:
                            _bump(p.stat().st_mtime)
                        except OSError:
                            continue

        return total, last_ts

    # ─── Indexer entry point ───────────────────────────────────────────────

    # ─── Provenance detection (path-structure based, env-portable) ─────────

    @classmethod
    def _is_claude_encoded_ref(cls, ref_path: Path) -> bool:
        """Detect Claude provenance by FSRef path structure: parent is
        ``.claude/projects/`` regardless of which HOME the test or runtime
        is using. Robust to real-user homes and to temp-dir test homes.
        """
        parent = ref_path.parent
        return parent.name == "projects" and parent.parent.name == ".claude"

    @classmethod
    async def from_fsref(cls, ref) -> list["ProjectFsRecord"]:
        """Indexer entry — upsert by canonical cwd inferred from the FSRef.

        Overrides the base ``Record.from_fsref`` directly (rather than the
        usual ``_from_fsref_sync`` override) because the body needs to await
        ``upsert_for_cwd`` — this is the rare from_fsref that does real DB
        work and must stay on the event loop.

        Provenance is inferred from the FSRef path structure:
          * ``.../.claude/projects/<encoded>`` → Claude (decode encoded → real cwd)
          * Otherwise → Codex (path IS the absolute cwd already)
        """
        ref_path = Path(ref._path)
        if cls._is_claude_encoded_ref(ref_path):
            real = _decode_claude_encoded(ref_path)
            if real is None or not cls._is_valid_cwd(real):
                return []
            rec = await cls.upsert_for_cwd(
                real,
                claude_project=True,
                encoded_path=ref_path.name,
            )
            return [rec]
        # Codex (or any non-Claude origin) — path is already the cwd.
        ref_str = str(ref_path)
        if not cls._is_valid_cwd(ref_str):
            return []
        rec = await cls.upsert_for_cwd(ref_str, codex_project=True)
        return [rec]

    @classmethod
    def getId(cls, ref) -> str:
        """Stable id derived from the canonical cwd — used by the indexer
        framework for FSRef-keyed dedup BEFORE ``from_fsref`` is invoked.

        We use ``uuid5`` here purely as a deterministic dedup key for the
        framework's per-FSRef cache; the persisted record's id remains the
        ``uuid4`` set in ``__init__``. The two id-spaces are separate.
        """
        ref_path = Path(ref._path)
        if cls._is_claude_encoded_ref(ref_path):
            real = _decode_claude_encoded(ref_path)
            cwd_key = real or str(ref_path)
        else:
            cwd_key = str(ref_path)
        cwd_key = canonical_posix_path(cwd_key) if cwd_key else str(ref_path)
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"project-fsref:{cwd_key}"))

    # ─── Discovery ─────────────────────────────────────────────────────────

    @classmethod
    def discover(cls, scope=None, **kwargs) -> list["ProjectFsRecord"]:
        """Return all PROJECT records persisted under records_root.

        The on-the-fly external scan (reading ``~/.claude/projects/`` directly
        without touching records_root) has been removed. The indexer is now
        the only writer; ``discover()`` is a pure read of what's persisted.
        Run an indexer pass to populate after a fresh DB.
        """
        from flow_sdk.fs_store.record import (  # noqa: PLC0415
            get_default_records_root,
            _NAME_SEP,
            _META_JSON,
            _migrate_old_format,
        )
        type_dir = get_default_records_root() / RecordType.PROJECT
        if not type_dir.is_dir():
            return []
        results: list[ProjectFsRecord] = []
        limit = kwargs.get("limit")
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
            except (json.JSONDecodeError, OSError, ValueError):
                continue
            results.append(rec)
            if limit is not None and len(results) >= limit:
                break
        return results

    @classmethod
    async def clean_temp_projects(cls) -> int:
        """Remove records pointing at temp paths from both records_root and the
        Claude on-disk encoded-name dirs (best-effort cleanup of stale data).

        Returns total directories removed.
        """
        removed = 0

        # Source 1: records_root/project/ — by mount_path or cwd
        from flow_sdk.fs_store.record import get_default_records_root  # noqa: PLC0415
        records_project_dir = get_default_records_root() / RecordType.PROJECT
        if records_project_dir.is_dir():
            for d in list(records_project_dir.iterdir()):
                if not d.is_dir():
                    continue
                mount_path = cls._read_mount_path(d) or cls._read_cwd(d)
                if mount_path and not cls._is_valid_mount_path(mount_path):
                    try:
                        rec = cls.load_record(d)
                        await rec.unindex()
                    except Exception:
                        pass
                    shutil.rmtree(d, ignore_errors=True)
                    removed += 1

        # Source 2: ~/.claude/projects/<encoded>/ — by decoded path
        projects_dir = _claude_projects_dir()
        if projects_dir.is_dir():
            for d in list(projects_dir.iterdir()):
                if d.is_dir() and not cls._is_valid_project_dir(d):
                    shutil.rmtree(d, ignore_errors=True)
                    removed += 1

        return removed

    @classmethod
    def _read_mount_path(cls, record_dir: Path) -> str | None:
        """Read fs_storage_mount_path from a project records-root dir (legacy)."""
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
    def _read_cwd(cls, record_dir: Path) -> str | None:
        """Read cwd from a project records-root dir (new format)."""
        for filename, key in (("metadata.json", "data"), ("state.json", "meta")):
            f = record_dir / filename
            if f.exists():
                try:
                    obj = json.loads(f.read_text())
                    return obj.get(key, {}).get("cwd")
                except Exception:
                    pass
        return None

    @classmethod
    def get(cls, uid: str, **kwargs) -> "ProjectFsRecord | None":
        """Find a record by id (records_root only)."""
        return super().get(uid, **kwargs)


# ──────────────────────────────────────────────────────────────────────────
# Backward-compat alias
# ──────────────────────────────────────────────────────────────────────────
# ``ClaudeProjectFsRecord`` is retained as a name alias so existing imports
# continue to resolve. The class is the consolidated ``ProjectFsRecord``
# with provenance flags; "ClaudeProjectFsRecord" is no longer Claude-only.
# Phase 7 will retire this alias once all callers are migrated.

ClaudeProjectFsRecord = ProjectFsRecord
