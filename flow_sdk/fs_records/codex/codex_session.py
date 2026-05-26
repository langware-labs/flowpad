"""CodexSessionRecord — represents a single Codex CLI chat session.

Source: ``$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl``
(default ``~/.codex/sessions/...``). Each line is a JSON envelope; the first
line is ``session_meta`` with ``payload.id`` (= thread_id), ``payload.cwd``,
``payload.cli_version``, ``payload.originator``.

Mirrors ``ClaudeSessionRecord`` (``flow_sdk/fs_records/claude/claude_session.py``):
- ``data_ref`` points to the external rollout JSONL.
- Lazy stats via ``_CodexSessionStatsProp`` descriptors that share one
  ``_codex_session_batch_stats`` cache populated on first access.
- ``discover()`` walks the date-bucketed sessions tree without parsing.
- ``from_jsonl()`` does a bounded first-lines read for envelope fields.

Read-only: rollouts are owned by Codex itself; we never write back.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import ClassVar

from flow_sdk._compat import Self
from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.instance_settings import get_instance_settings

from .properties import _CodexSessionStatsProp


_HEAD_LINES = 64


def _iter_head_json(path: Path):
    """Yield parsed JSON envelopes from the first few JSONL lines."""
    with open(path, encoding="utf-8") as fh:
        for _, line in zip(range(_HEAD_LINES), fh):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def _extract_thread_id(filename: str) -> str | None:
    """Pull the thread_id off a Codex rollout filename.

    Filename pattern: ``rollout-<ISO-timestamp>-<thread_id>.jsonl``.
    The thread_id is a UUID — last 5 hyphen-separated groups of the stem.
    """
    stem = filename
    if stem.endswith(".jsonl"):
        stem = stem[: -len(".jsonl")]
    if not stem.startswith("rollout-"):
        return None
    parts = stem[len("rollout-"):].split("-")
    if len(parts) < 5:
        return None
    return "-".join(parts[-5:])


class CodexSessionRecord(Record):
    """A single Codex CLI session backed by a rollout JSONL transcript."""

    _record_type: ClassVar[str] = RecordType.CODEX_SESSION
    _indexed_by_default: ClassVar[bool] = True

    # ── Lazy stats descriptors ────────────────────────────────────────────────
    session_id: str = _CodexSessionStatsProp("session_id", default="")
    cwd: str = _CodexSessionStatsProp("cwd", default="")
    version: str = _CodexSessionStatsProp("version", default="")
    originator: str = _CodexSessionStatsProp("originator", default="")
    git_branch: str = _CodexSessionStatsProp("git_branch", default="")
    model: str | None = _CodexSessionStatsProp("model", default=None)
    effort: str | None = _CodexSessionStatsProp("effort", default=None)
    personality: str | None = _CodexSessionStatsProp("personality", default=None)
    approval_policy: str | None = _CodexSessionStatsProp("approval_policy", default=None)
    sandbox_policy: str | None = _CodexSessionStatsProp("sandbox_policy", default=None)
    message_count: int = _CodexSessionStatsProp("message_count", default=0)
    user_message_count: int = _CodexSessionStatsProp("user_message_count", default=0)
    assistant_message_count: int = _CodexSessionStatsProp("assistant_message_count", default=0)
    tool_uses: int = _CodexSessionStatsProp("tool_uses", default=0)
    input_tokens: int = _CodexSessionStatsProp("input_tokens", default=0)
    output_tokens: int = _CodexSessionStatsProp("output_tokens", default=0)
    cache_read_input_tokens: int = _CodexSessionStatsProp("cache_read_input_tokens", default=0)
    cache_creation_input_tokens: int = _CodexSessionStatsProp("cache_creation_input_tokens", default=0)
    last_user_message: str | None = _CodexSessionStatsProp("last_user_message", default=None)
    last_assistant_message: str | None = _CodexSessionStatsProp("last_assistant_message", default=None)
    last_stop_reason: str | None = _CodexSessionStatsProp("last_stop_reason", default=None)
    modified_at: str | None = _CodexSessionStatsProp("modified_at", default=None)
    created_at: str | None = _CodexSessionStatsProp("created_at", default=None)
    estimated_cost_usd: float = _CodexSessionStatsProp("estimated_cost_usd", default=0.0)
    models_used: list = _CodexSessionStatsProp("models_used", default=None, list_key="models_used")
    primary_model: str | None = _CodexSessionStatsProp("primary_model", default=None)
    worker_type: str = _CodexSessionStatsProp("worker_type", default="codex")

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CODEX_SESSION
        super().__init__(**kwargs)
        # Read-only enforcement via FSRef on the source file.
        _sf = object.__getattribute__(self, "_source_file")
        object.__setattr__(self, "_asset_ref", FSRef(_sf or "/", read_only=True))
        # Set id from thread_id captured during construction or first-line scan.
        session_id = object.__getattribute__(self, "__dict__").get("session_id", "")
        if session_id:
            self.id = session_id
            if not self.name:
                self.name = (
                    object.__getattribute__(self, "__dict__").get("last_user_message")
                    or session_id
                )

    @property
    def jsonl_path(self) -> str | None:
        """Path to the rollout JSONL file."""
        d = object.__getattribute__(self, "__dict__")
        return d.get("jsonl_path") or d.get("source_file_field") or self.source_file

    @property
    def search_title(self) -> str | None:
        return self.last_user_message or self.name or None

    @property
    def search_content(self) -> str | None:
        from .properties import _get_codex_session_batch_stats
        stats = _get_codex_session_batch_stats(self)
        return stats.get("search_content")

    @classmethod
    def _from_fsref_sync(cls, ref) -> list["CodexSessionRecord"]:
        """Indexer entry — construct from an FSRef pointing at a rollout JSONL."""
        return [cls.from_jsonl(ref._path)]

    @classmethod
    def getId(cls, ref) -> str:
        """Stable id = session_meta payload.id (the thread_id)."""
        try:
            for raw in _iter_head_json(ref._path):
                if raw.get("type") == "session_meta":
                    payload = raw.get("payload") or {}
                    if payload.get("id"):
                        return str(payload["id"])
                if raw.get("type") == "thread.started" and raw.get("thread_id"):
                    return str(raw["thread_id"])
                # Other shapes — keep scanning a few lines.
        except OSError:
            pass
        # Fall back to filename-derived thread_id.
        tid = _extract_thread_id(ref._path.name)
        if tid:
            return tid
        return ref._path.stem

    @classmethod
    def discover_paths_iter(cls, limit: int | None = None, **kwargs):
        """Lazy generator yielding rollout JSONL paths newest-first by date dir."""
        sessions_root = get_instance_settings().codex_sessions_dir
        if not sessions_root.is_dir():
            return
        count = 0
        # YYYY/MM/DD — sort descending so newest dates come first.
        for year_dir in sorted(sessions_root.iterdir(), reverse=True):
            if not year_dir.is_dir():
                continue
            for month_dir in sorted(year_dir.iterdir(), reverse=True):
                if not month_dir.is_dir():
                    continue
                for day_dir in sorted(month_dir.iterdir(), reverse=True):
                    if not day_dir.is_dir():
                        continue
                    for jsonl_file in sorted(day_dir.glob("rollout-*.jsonl"), reverse=True):
                        yield jsonl_file
                        count += 1
                        if limit is not None and count >= limit:
                            return

    @classmethod
    def discover(cls, scope=None, **kwargs) -> list["CodexSessionRecord"]:
        """Find all rollout JSONL files under ``$CODEX_HOME/sessions/``."""
        limit = kwargs.get("limit")
        results: list[CodexSessionRecord] = []
        for jsonl_file in cls.discover_paths_iter(limit=limit):
            try:
                results.append(cls.from_jsonl(jsonl_file))
            except (json.JSONDecodeError, OSError):
                continue
        return results

    @classmethod
    def get(cls, uid: str, scope=None, **kwargs) -> "CodexSessionRecord | None":
        """Find a session by thread_id (suffix-match against rollout filenames).

        Codex stores rollouts as ``rollout-<ts>-<thread_id>.jsonl`` so a
        suffix scan is O(N) over rollout files. For workflows that already
        know the date, pass ``date_path="YYYY/MM/DD"`` for an O(1) lookup.
        """
        sessions_root = get_instance_settings().codex_sessions_dir
        if not sessions_root.is_dir():
            return None
        suffix = f"-{uid}.jsonl"

        date_path = kwargs.get("date_path")
        if date_path:
            day = sessions_root / date_path
            if day.is_dir():
                for p in day.glob("rollout-*.jsonl"):
                    if p.name.endswith(suffix):
                        try:
                            return cls.from_jsonl(p)
                        except (json.JSONDecodeError, OSError):
                            return None

        for p in sessions_root.rglob("rollout-*.jsonl"):
            if p.name.endswith(suffix):
                try:
                    return cls.from_jsonl(p)
                except (json.JSONDecodeError, OSError):
                    continue
        return None

    @classmethod
    def from_jsonl(cls, path: str | Path) -> Self:
        """Build a session record from a rollout JSONL path.

        Reads only the first few JSONL lines to extract envelope fields (id,
        cwd, version, originator). Stats are loaded lazily on first attribute
        access via ``_CodexSessionStatsProp`` descriptors.
        """
        path = Path(path)
        session_id = _extract_thread_id(path.name) or path.stem
        cwd = ""
        version = ""
        originator = ""

        try:
            for raw in _iter_head_json(path):
                rtype = raw.get("type") or ""
                if rtype == "session_meta":
                    payload = raw.get("payload") or {}
                    if payload.get("id"):
                        session_id = str(payload["id"])
                    if not cwd and payload.get("cwd"):
                        cwd = str(payload["cwd"])
                    if not version and payload.get("cli_version"):
                        version = str(payload["cli_version"])
                    if not originator and payload.get("originator"):
                        originator = str(payload["originator"])
                elif rtype == "thread.started" and raw.get("thread_id"):
                    session_id = str(raw["thread_id"])
        except OSError:
            pass

        kwargs: dict = {
            "session_id": session_id,
            "cwd": cwd,
            "version": version,
            "originator": originator,
            "jsonl_path": str(path),
            "source_file": str(path),
            "path": str(path),
        }
        return cls(**kwargs)
