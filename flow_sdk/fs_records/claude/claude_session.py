"""ClaudeSessionRecord — represents a Claude Code chat session.

Source: ~/.claude/projects/<encoded-path>/<session-id>.jsonl
Each line is a JSON entry with a shared envelope (sessionId, cwd, version,
gitBranch, slug, timestamp, uuid) plus a type-specific payload.

Architecture (Gap 2 — lazy stats via PropertyRecord):
- ``data_ref`` points to the external JSONL transcript file.
- Session metadata (id, type, slug) is captured in a quick first-line scan.
- All aggregated stats (message counts, token usage, cost, etc.) are
  ``_SessionStatsProp`` descriptors that parse the JSONL lazily on first
  access and cache the result in ``_session_batch_stats`` (instance attribute).
- The ``_data`` dict holds only the path references and envelope fields set at
  construction time.  This keeps ``discover()`` fast — no full JSONL parse on
  listing sessions.

Backward compat: ``_session_batch_stats`` falls back to ``dict(_data)`` when
no JSONL file is available, so unit tests that construct records with explicit
keyword arguments continue to work without modification.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar, Literal
from flow_sdk.fs_records.agent_status import WorkerStatus, _tail_status
from flow_sdk._compat import Self

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_records.claude.properties import (
    SessionActivePropertyRecord,
    SessionStartTimePropertyRecord,
    _SessionStatsProp,
)

if TYPE_CHECKING:
    from .claude_transcript_entry import ClaudeTranscriptEntryFsRecord


# ---------------------------------------------------------------------------
# Re-export for external callers that imported _session_estimated_cost from
# this module (e.g. session_stats.py itself doesn't import it back).
# ---------------------------------------------------------------------------
def _extract_text(content: object) -> str | None:
    """Extract plain text from a message content field (str or list of blocks)."""
    if isinstance(content, str):
        text = content.strip()
        return text if text and not text.startswith("<") else None
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text", "").strip()
                return text if text and not text.startswith("<") else None
    return None


def _session_estimated_cost(
    input_tokens: int,
    output_tokens: int,
    cache_read: int,
    cache_creation: int,
    model: str | None,
) -> float:
    """Estimate session cost in USD from token counts and model name.

    Delegates to ``_estimate_cost`` in session_stats to avoid duplication.
    Kept here as a named export for backward compatibility.
    """
    from flow_sdk.fs_records.claude.properties.session_stats import _estimate_cost
    return _estimate_cost(input_tokens, output_tokens, cache_read, cache_creation, model)


class ClaudeSessionRecord(Record):
    """A single Claude Code chat session.

    Mapped from the JSONL transcript at
    ``~/.claude/projects/<project>/<session-id>.jsonl``.

    Session stats (message counts, token usage, etc.) are computed lazily from
    the JSONL transcript on first attribute access and cached for the lifetime of
    the record object.  ``discover()`` is therefore fast — it only reads the
    first few lines of each JSONL file to extract the session ID and slug.
    """

    _record_type: ClassVar[str] = RecordType.CLAUDE_SESSION
    _indexed_by_default: ClassVar[bool] = True

    # stop_reason values that mean Claude finished its turn
    COMPLETE_STOP_REASONS: ClassVar[set[str]] = {"end_turn", "stop_sequence"}

    # ── Non-stat PropertyRecords (not backed by batch stats) ──────────────
    # Pydantic-Field-style descriptors — __set_name__ auto-registers them
    is_active: bool = SessionActivePropertyRecord()
    start_time: str | None = SessionStartTimePropertyRecord()

    # ── Lazy stats PropertyRecords (backed by _parse_jsonl_stats) ─────────
    # All populated in one JSONL parse on first access (shared batch cache).
    session_id: str = _SessionStatsProp("session_id", default="")
    cwd: str = _SessionStatsProp("cwd", default="")
    version: str = _SessionStatsProp("version", default="")
    git_branch: str = _SessionStatsProp("git_branch", default="")
    slug: str = _SessionStatsProp("slug", default="")
    model: str | None = _SessionStatsProp("model", default=None)
    message_count: int = _SessionStatsProp("message_count", default=0)
    user_message_count: int = _SessionStatsProp("user_message_count", default=0)
    assistant_message_count: int = _SessionStatsProp("assistant_message_count", default=0)
    input_tokens: int = _SessionStatsProp("input_tokens", default=0)
    output_tokens: int = _SessionStatsProp("output_tokens", default=0)
    cache_read_input_tokens: int = _SessionStatsProp("cache_read_input_tokens", default=0)
    cache_creation_input_tokens: int = _SessionStatsProp("cache_creation_input_tokens", default=0)
    duration_ms: int = _SessionStatsProp("duration_ms", default=0)
    tools_used: list = _SessionStatsProp("tools_used", default=None, list_key="tools_used")
    has_plan: bool = _SessionStatsProp("has_plan", default=False)
    last_stop_reason: str | None = _SessionStatsProp("last_stop_reason", default=None)
    project_encoded_name: str = _SessionStatsProp("project_encoded_name", default="")
    last_user_message: str | None = _SessionStatsProp("last_user_message", default=None)
    modified_at: str | None = _SessionStatsProp("modified_at", default=None)
    task_path: str | None = _SessionStatsProp("task_path", default=None)
    estimated_cost_usd: float = _SessionStatsProp("estimated_cost_usd", default=0.0)
    models_used: list = _SessionStatsProp("models_used", default=None, list_key="models_used")
    primary_model: str | None = _SessionStatsProp("primary_model", default=None)
    created_at: str | None = _SessionStatsProp("created_at", default=None)

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_SESSION
        super().__init__(**kwargs)
        # Per-FSRef read-only enforcement: always mark this record as read-only
        # via the _asset_ref FSRef so _is_read_only() returns True regardless of
        # whether a source file path is set.  When a real JSONL path is available
        # we use it; otherwise a sentinel "/" path carries the flag.
        _sf = object.__getattribute__(self, "_source_file")
        object.__setattr__(self, "_asset_ref", FSRef(_sf or "/", read_only=True))
        # Set id and name from attrs (populated by constructor kwargs or from_jsonl).
        # Priority: custom_title (user /rename) > slug (auto-generated) > session_id
        session_id = object.__getattribute__(self, "__dict__").get("session_id", "")
        if session_id:
            self.id = session_id
            if not self.name:
                custom_title = object.__getattribute__(self, "__dict__").get("custom_title", "") or ""
                self.name = custom_title or object.__getattribute__(self, "__dict__").get("slug", "") or session_id

    @property
    def jsonl_path(self) -> str | None:
        """Path to the JSONL transcript file (backward compat accessor)."""
        d = object.__getattribute__(self, "__dict__")
        return d.get("jsonl_path") or d.get("source_file_field") or self.source_file

    @property
    def source_path(self) -> str:
        """On-disk path used by search result navigation (the JSONL transcript file)."""
        return self.jsonl_path or ""

    @property
    def status(self) -> WorkerStatus:
        """Derive status from the last 4 KB of the JSONL transcript (tail-read, ~60µs)."""
        path = self.jsonl_path
        if not path:
            return WorkerStatus.IDLE
        return _tail_status(path)

    def to_dict(self) -> dict:
        """Serialize to dict, including all lazy PropertyRecord stats.

        Accessing PropertyRecord values here triggers the JSONL parse on first
        call; subsequent calls use the cached ``_session_batch_stats``.
        """
        d = super().to_dict()
        # Include all _SessionStatsProp values (triggers batch parse on miss)
        for name, prop in (self._property_types or {}).items():
            if name not in d:
                d[name] = self.get_prop(name)
        d["status"] = self.status
        return d

    def meta_dict(self) -> dict:
        """Fast meta_dict: avoids triggering the full JSONL batch stats parse.

        meta_dict() is called on every record during bulk indexing (via
        Entity.from_record). For session records the base implementation calls
        to_dict() which triggers _get_session_batch_stats() — a full JSONL
        parse that can take 500ms–1.5s for large sessions.

        This override derives the same fields from cheap sources:
        - id / type / name: already in instance __dict__ from discovery
        - modified_at: O(1) file mtime syscall
        - created_at: reads only the first line of the JSONL
        - status: defaults to "complete" (correct for the vast majority of
          sessions; active sessions are re-indexed when they change)

        Fast path: if _session_batch_stats is already cached (e.g. the user
        viewed this session in the UI), falls back to the full to_dict() path
        since the parse cost has already been paid.
        """
        import os as _os

        inst = object.__getattribute__(self, "__dict__")

        # Fast path: stats already cached — full to_dict() is now free.
        if "_session_batch_stats" in inst:
            return super().meta_dict()

        result: dict = {}

        # id and name are always set during discovery (no parse needed).
        for k in ("id", "name"):
            v = inst.get(k)
            if v is not None:
                result[k] = v

        # type may be a RecordType enum.
        t = inst.get("type")
        if t is not None:
            result["type"] = t.value if hasattr(t, "value") else str(t)

        path = inst.get("jsonl_path") or inst.get("_source_file") or ""

        # updated_date: single O(1) stat() call.
        if path:
            try:
                from datetime import datetime as _dt, timezone as _tz
                result["updated_date"] = _dt.fromtimestamp(_os.path.getmtime(path), tz=_tz.utc).isoformat()
            except OSError:
                pass

        # created_date: read only the first line of the JSONL (microseconds).
        if path:
            try:
                with open(path, "rb") as fh:
                    first_line = fh.readline()
                entry = json.loads(first_line)
                ts = entry.get("timestamp")
                if ts:
                    result["created_date"] = ts
            except Exception:
                pass

        # status: "complete" is correct for all finished sessions.
        # Active sessions are re-indexed on change via index_required.
        result["status"] = "complete"

        # message_count: set cheaply by from_jsonl() via binary line count.
        mc = inst.get("message_count")
        if mc is not None:
            result["message_count"] = mc

        # slug and cwd: set cheaply by from_jsonl() via first-line scan.
        slug = inst.get("slug")
        if slug:
            result["slug"] = slug
        cwd = inst.get("cwd")
        if cwd:
            result["cwd"] = cwd

        return result

    def to_transcript_dicts(self, include_raw_json: bool = False) -> list[dict]:
        """Return filtered transcript entries as serializable dicts.

        By default excludes the ``raw_json`` field from each entry dict
        to keep response size manageable.
        """
        entries = self.filtered_entries
        if include_raw_json:
            return [e.meta_dict() for e in entries]
        return [
            {k: v for k, v in e.meta_dict().items() if k != "raw_json"}
            for e in entries
        ]

    EXCLUDED_ENTRY_TYPES: ClassVar[list[str]] = ["file-history-snapshot", "progress"]

    def read_record(self, path: Path) -> None:
        """Read session from JSONL — delegates to ``from_jsonl``."""
        if path.suffix == ".jsonl" and path.exists():
            loaded = self.__class__.from_jsonl(path)
            # Copy all instance attrs from loaded into self, skipping
            # class-level properties (which cannot be set via object.__setattr__)
            loaded_d = object.__getattribute__(loaded, "__dict__")
            _skip = {"fs_sync"}
            for k, v in loaded_d.items():
                if k.startswith("_") or k in _skip:
                    continue
                # Skip if there's a property descriptor (no setter would raise)
                for cls in type(self).__mro__:
                    if k in cls.__dict__ and isinstance(cls.__dict__[k], property):
                        break
                else:
                    object.__setattr__(self, k, v)
            # Copy backing attrs for property descriptors that are essential for
            # lazy stat parsing (_source_file backs the source_file property and
            # is used by _get_session_batch_stats to find the JSONL path).
            loaded_sf = object.__getattribute__(loaded, "_source_file")
            if loaded_sf:
                object.__setattr__(self, "_source_file", loaded_sf)
            # Invalidate the batch stats cache so it's re-parsed with the new path
            try:
                object.__delattr__(self, "_session_batch_stats")
            except AttributeError:
                pass
        elif path.exists():
            super().read_record(path)

    @property
    def filtered_entries(self) -> list[ClaudeTranscriptEntryFsRecord]:
        """Return transcript entries with noisy types excluded.

        Uses ``EXCLUDED_ENTRY_TYPES`` as a blocklist.
        """
        return [
            e for e in self.transcript_entries
            if e.entry_type not in self.EXCLUDED_ENTRY_TYPES
        ]

    @property
    def transcript_entries(self) -> list[ClaudeTranscriptEntryFsRecord]:
        """Lazily load transcript entries from the JSONL file.

        Returns a list of transcript entry records (base or type-specific).
        """
        from .transcript_records import create_transcript_entry

        path = self.jsonl_path or ""
        if not path or not Path(path).is_file():
            return []
        entries = []
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    continue
                entries.append(create_transcript_entry(raw))
        return entries

    @property
    def entries(self) -> list[ClaudeTranscriptEntryFsRecord]:
        """Alias for ``filtered_entries`` — used by the tree-walk API."""
        return self.filtered_entries

    @property
    def summary_log(self) -> str:
        """Newline-joined one-line summaries of filtered transcript entries."""
        return "\n".join(
            f"[{i:4d}]  {e.summary}" for i, e in enumerate(self.filtered_entries, 1)
        )

    def _parse_fts(self) -> tuple[str | None, str | None]:
        """Parse JSONL transcript and return (title, content) for FTS indexing.

        title   = last custom-title entry (auto-generated by Claude or user /rename), truncated to 120 chars
        content = one line per user/assistant turn

        Result is cached in ``_fts_cache`` so both ``search_title`` and
        ``search_content`` only trigger one file read. Returns (None, None)
        when the JSONL file is unavailable or unreadable.
        """
        cache = object.__getattribute__(self, "__dict__").get("_fts_cache")
        if cache is not None:
            return cache
        path_str = object.__getattribute__(self, "__dict__").get("jsonl_path")
        if not path_str:
            result: tuple[str | None, str | None] = (None, None)
            object.__setattr__(self, "_fts_cache", result)
            return result
        p = Path(path_str)
        if not p.is_file():
            result = (None, None)
            object.__setattr__(self, "_fts_cache", result)
            return result
        lines: list[str] = []
        last_custom_title: str | None = None
        try:
            with open(p, encoding="utf-8") as fh:
                for raw_line in fh:
                    raw_line = raw_line.strip()
                    if not raw_line:
                        continue
                    try:
                        entry = json.loads(raw_line)
                    except json.JSONDecodeError:
                        continue
                    etype = entry.get("type")
                    if etype == "custom-title":
                        ct = entry.get("customTitle")
                        if ct:
                            last_custom_title = ct  # keep last rename
                        continue
                    if etype not in ("user", "assistant"):
                        continue
                    msg = entry.get("message") or {}
                    content = msg.get("content") if isinstance(msg, dict) else None
                    text = _extract_text(content)
                    if not text:
                        continue
                    if etype == "user":
                        lines.append(f"user: {text}")
                    else:
                        lines.append(f"assistant: {text[:500]}")
        except OSError:
            result = (None, None)
            object.__setattr__(self, "_fts_cache", result)
            return result
        # Use custom-title (auto-generated or user /rename); no fallback to last user message
        title = last_custom_title[:120] if last_custom_title else None
        result = (title, "\n".join(lines) or None)
        object.__setattr__(self, "_fts_cache", result)
        return result

    @property
    def search_title(self) -> str | None:
        """Last user prompt, used as FTS title for BM25 name-weight boost."""
        return self._parse_fts()[0]

    @property
    def search_content(self) -> str | None:
        """One line per user/assistant turn from the JSONL transcript."""
        return self._parse_fts()[1]

    @classmethod
    def discovery_items_count(cls, limit: int | None = None) -> int:
        """Count JSONL session files across ~/.claude/projects/ dirs (fast, no file reads)."""
        projects_dir = Path.home() / ".claude" / "projects"
        if not projects_dir.is_dir():
            return 0
        count = sum(
            1
            for d in projects_dir.iterdir()
            if d.is_dir()
            for _ in d.glob("*.jsonl")
        )
        return min(count, limit) if limit is not None else count

    @classmethod
    async def from_fsref(cls, ref) -> list["ClaudeSessionRecord"]:
        """Indexer entry point — construct from an FSRef emitted by claude_sessions_fn."""
        return [cls.from_jsonl(ref._path)]

    @classmethod
    def discover_paths_iter(cls, limit: int | None = None, **kwargs):
        """Lazy generator — yields Path objects for each JSONL file (no file reads)."""
        projects_dir = Path.home() / ".claude" / "projects"
        if not projects_dir.is_dir():
            return
        count = 0
        for project_dir in sorted(projects_dir.iterdir()):
            if not project_dir.is_dir():
                continue
            for jsonl_file in sorted(project_dir.glob("*.jsonl")):
                yield jsonl_file
                count += 1
                if limit is not None and count >= limit:
                    return

    @classmethod
    def discover_iter(cls, limit: int | None = None, scope=None, **kwargs):
        """Lazy generator — yields one ClaudeSessionRecord per JSONL file."""
        for jsonl_file in cls.discover_paths_iter(limit=limit):
            try:
                yield cls.from_jsonl(jsonl_file)
            except (json.JSONDecodeError, OSError):
                continue

    @classmethod
    def discover(cls, scope=None, **kwargs) -> list[ClaudeSessionRecord]:
        """Find all session JSONL files under ~/.claude/projects/.

        Uses the fast minimal ``from_jsonl()`` — only reads the first few lines
        of each JSONL to extract session ID and slug.  Stats are loaded lazily.
        """
        return list(cls.discover_iter(scope=scope, **kwargs))

    @classmethod
    def discover_one(cls, uid: str, scope=None, **kwargs) -> ClaudeSessionRecord | None:
        """Find a specific session by session ID.

        Pass ``project="/abs/path"`` for O(1) lookup via the encoded
        project directory.  Without it, falls back to scanning all
        project directories.
        """
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
                    continue
        return None

    @classmethod
    def from_jsonl(
        cls, path: str | Path, *, project_encoded_name: str | None = None
    ) -> Self:
        """Build a session record from a JSONL transcript file path.

        O(1) read cost regardless of transcript size:
          - head ``_HEAD_BYTES`` for session_id / slug / cwd (first-line fields).
          - tail ``_TAIL_BYTES`` for the most-recent custom-title (``/rename``
            can be written at any point in the session, but in practice the
            latest one is near the end).

        ``message_count`` is intentionally NOT computed eagerly — it's a
        ``_SessionStatsProp`` on the class and parses lazily on first access.
        """
        _HEAD_BYTES = 4096
        _TAIL_BYTES = 16384

        path = Path(path)
        session_id = path.stem  # fallback
        slug = ""
        cwd = ""
        custom_title = ""

        # ── head: first few lines cover session_id / slug / cwd ────────────
        try:
            with open(path, "rb") as fh:
                head = fh.read(_HEAD_BYTES).decode("utf-8", errors="replace")
            for line in head.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    # Partial line at the 4KB boundary — stop here.
                    break
                if raw.get("sessionId"):
                    session_id = raw["sessionId"]
                if raw.get("slug"):
                    slug = raw["slug"]
                if not cwd and raw.get("cwd"):
                    cwd = raw["cwd"]
                if session_id and slug and cwd:
                    break
        except OSError:
            pass

        # ── tail: most-recent custom-title only (same trick as _tail_status) ─
        try:
            sz = path.stat().st_size
            with open(path, "rb") as fb:
                if sz > _TAIL_BYTES:
                    fb.seek(sz - _TAIL_BYTES)
                tail = fb.read().decode("utf-8", errors="replace")
            # Walk tail lines in reverse; first valid custom-title wins.
            for line in reversed(tail.splitlines()):
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    # Line straddled the seek boundary or mid-write — skip.
                    continue
                if raw.get("type") == "custom-title" and raw.get("customTitle"):
                    custom_title = raw["customTitle"]
                    break
        except OSError:
            pass

        derived_encoded = project_encoded_name or path.parent.name
        return cls(
            session_id=session_id,
            slug=slug,
            cwd=cwd,
            custom_title=custom_title,
            # message_count intentionally omitted — _SessionStatsProp parses lazily.
            jsonl_path=str(path),
            source_file=str(path),
            path=str(path),
            project_encoded_name=derived_encoded,
        )


# Backward compatibility alias
ClaudeSessionFsRecord = ClaudeSessionRecord
