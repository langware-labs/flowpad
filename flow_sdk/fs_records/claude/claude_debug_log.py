"""ClaudeSessionDebugLogRecord — a Claude Code debug session log.

Source: ~/.claude/debug/<session-uuid>.txt

Each file is a plain-text debug log with two kinds of errors:

1. **Hook errors** — multi-line blocks starting with
   ``Hook <name> (<event>) error:`` followed by a traceback.

2. **Runtime errors** — single ``[ERROR]`` log lines from Claude Code
   (tool failures, MCP errors, file-not-found, lock errors, etc.).

The record parses both on load and exposes them via ``to_dict()``.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar, Iterator
from flow_sdk._compat import Self

from flow_sdk.fs_store import PropertyRecord, Record, RecordType
from flow_sdk.instance_settings import get_instance_settings

# --- Compiled patterns (module-level, compiled once) ---

_ERROR_MARKER = re.compile(r"Hook (.+?) \(([^)]+)\) error:")
_TIMESTAMP_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z")
_DEBUG_LINE = re.compile(r"\[DEBUG\]")
_ERROR_LOG_LINE = re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+\[ERROR\]\s+(.*)")
_EXCEPTION_RE = re.compile(
    r"^(ModuleNotFoundError|ImportError|FileNotFoundError|PermissionError|"
    r"OSError|TypeError|ValueError|RuntimeError|KeyError|AttributeError|"
    r"SyntaxError|ConnectionError|TimeoutError|EOFError|StopIteration)"
)


# --- HookError (nested value object, not a standalone Record) ---


@dataclass
class HookError:
    """A single hook error parsed from a debug log."""

    hook: str = ""
    event: str = ""
    timestamp: str = ""
    traceback: list[str] = field(default_factory=list)
    root_cause: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "hook": self.hook,
            "event": self.event,
            "timestamp": self.timestamp,
            "traceback": self.traceback,
            "root_cause": self.root_cause,
        }


@dataclass
class LogError:
    """A single [ERROR] log line from Claude Code."""

    timestamp: str = ""
    message: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "timestamp": self.timestamp,
            "message": self.message,
        }


# --- Parser ---


def parse_debug_log(path: Path) -> tuple[list[HookError], list[LogError]]:
    """Parse all hook errors and [ERROR] log lines in a single pass."""
    hook_errors: list[HookError] = []
    log_errors: list[LogError] = []
    current: HookError | None = None

    with open(path, "r", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")

            # Check for hook error start marker
            m = _ERROR_MARKER.search(line)
            if m:
                if current is not None:
                    hook_errors.append(current)
                ts_m = _TIMESTAMP_RE.search(line)
                current = HookError(
                    hook=m.group(1),
                    event=m.group(2),
                    timestamp=ts_m.group(0) if ts_m else "unknown",
                )
                continue

            # Inside a hook error block — collect traceback lines
            if current is not None:
                if _DEBUG_LINE.search(line) or _ERROR_LOG_LINE.match(line):
                    hook_errors.append(current)
                    current = None
                    # Fall through to check if this line is an [ERROR]
                else:
                    if len(current.traceback) < 30:
                        current.traceback.append(line)
                        if _EXCEPTION_RE.match(line):
                            current.root_cause = line
                    continue

            # Check for [ERROR] log line
            em = _ERROR_LOG_LINE.match(line)
            if em:
                log_errors.append(
                    LogError(
                        timestamp=em.group(1),
                        message=em.group(2),
                    )
                )

    if current is not None:
        hook_errors.append(current)

    return hook_errors, log_errors


def parse_hook_errors(path: Path) -> list[HookError]:
    """Parse only hook errors (backward compat)."""
    hook_errors, _ = parse_debug_log(path)
    return hook_errors


def has_errors(path: Path) -> bool:
    """Quick check — does this file contain hook errors or [ERROR] lines?"""
    with open(path, "r", errors="replace") as f:
        for line in f:
            if "[ERROR]" in line:
                return True
            if "error:" in line and _ERROR_MARKER.search(line):
                return True
    return False


def has_hook_errors(path: Path) -> bool:
    """Quick check — does this file contain any hook error markers?"""
    with open(path, "r", errors="replace") as f:
        for line in f:
            if "error:" in line and _ERROR_MARKER.search(line):
                return True
    return False


# --- Transcript discovery ---


def _find_transcript(session_id: str) -> str:
    """Find the JSONL transcript path for a given session ID.

    Scans ``~/.claude/projects/*/`` for ``{session_id}.jsonl``.
    Returns the full path as a string, or empty string if not found.
    """
    projects_dir = get_instance_settings().claude_projects_dir
    if not projects_dir.is_dir():
        return ""
    fname = f"{session_id}.jsonl"
    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue
        candidate = project_dir / fname
        if candidate.exists():
            return str(candidate)
    return ""


# --- Record ---


class ClaudeSessionDebugLogRecord(Record):
    """A Claude Code debug session log with parsed hook errors and log errors.

    Read-only record backed by ``~/.claude/debug/<session-id>.txt``.
    Errors are parsed on load. The ``discovery()`` method creates
    ``ClaudeErrorRecord`` entries for each unique error fingerprint
    and persists the fingerprint list to ``state.json``.
    """

    _record_type: ClassVar[str] = RecordType.CLAUDE_DEBUG_LOG

    error_fingerprints: list = PropertyRecord(
        list_key="error_fingerprints",
        ttl=-1,  # populated by discovery(); never auto-invalidated on get_prop()
        default=[],
    )

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_DEBUG_LOG
        super().__init__(**kwargs)
        session_id = getattr(self, "session_id", None) or kwargs.get("session_id", "")
        if session_id:
            self.id = session_id
            if not self.name:
                self.name = session_id
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    def read_record(self, path: Path) -> None:
        """Parse the debug log file instead of reading JSON."""
        self.source_file = str(path)
        self.session_id = path.stem
        self.id = self.session_id
        self.name = self.session_id

        hook_errs, log_errs = parse_debug_log(path)
        self.hook_errors = [e.to_dict() for e in hook_errs]
        self.log_errors = [e.to_dict() for e in log_errs]
        self.error_count = len(hook_errs) + len(log_errs)
        self.log_error_count = len(log_errs)
        self.has_errors = self.error_count > 0

        self.jsonl_path = _find_transcript(self.session_id)

        # Set folder path so RecordState can write state.json
        if self.session_id:
            self.path = str(self.default_path)

    @classmethod
    def from_debug_file(cls, path: Path) -> Self:
        """Build a record by parsing a debug log file."""
        rec = cls()
        rec.read_record(path)
        return rec

    @classmethod
    def debug_dir(cls) -> Path:
        """Return the platform-appropriate debug log directory."""
        d = get_instance_settings().claude_home / "debug"
        if d.is_dir():
            return d
        # Windows AppData fallback
        import sys

        if sys.platform == "win32":
            appdata = os.environ.get("APPDATA", "")
            if appdata:
                d = Path(appdata) / "claude" / "debug"
                if d.is_dir():
                    return d
        return Path.home() / ".claude" / "debug"

    @classmethod
    def discover(cls, scope=None, hours: float = 168.0, **kwargs) -> list[ClaudeSessionDebugLogRecord]:
        """Find all debug log records with errors within *hours* window."""
        rl = ClaudeSessionDebugLogRecordList(hours=hours)
        return list(rl)

    @classmethod
    def get(cls, uid: str, scope=None, **kwargs) -> ClaudeSessionDebugLogRecord | None:
        """Load a specific debug log session by ID."""
        rl = ClaudeSessionDebugLogRecordList()
        return rl.get(uid)

    def discovery(self, force: bool = False, recursive: bool = False) -> "ClaudeSessionDebugLogRecord":
        """Parse the debug log, create missing ClaudeErrorRecords, and persist fingerprints.

        force=False: skip re-parse if source file mtime hasn't changed since last discovery.
        force=True: always re-parse and create any missing error records.

        Returns self for chaining.
        """
        # Ensure path is set for state.json persistence
        if self.session_id and not self.path:
            self.path = str(self.default_path)

        index = self._get_state()

        # Skip re-parse if already discovered and source mtime unchanged (unless force)
        if index.is_discovered() and not force:
            try:
                src_mtime = Path(self.source_file).stat().st_mtime
                da = index._discovered_at
                if da and src_mtime <= da.timestamp():
                    return self
            except OSError:
                pass

        # Parse the debug log
        src = Path(self.source_file) if self.source_file else None
        if src is None or not src.exists():
            index.mark_discovered()
            index.save()
            return self

        try:
            hook_errors, log_errors = parse_debug_log(src)
        except OSError:
            return self

        jsonl_path = _find_transcript(self.session_id) if self.session_id else ""
        all_fps: list[str] = []

        # Deferred imports to avoid circular dependency (claude_error imports claude_debug_log)
        from .claude_error import (  # noqa: PLC0415
            ClaudeErrorRecord,
            ErrorCategory,
            _fingerprint_hook,
            _fingerprint_log,
        )

        # Hook errors
        for he in hook_errors:
            fp = _fingerprint_hook(he.hook, he.event, he.root_cause)
            all_fps.append(fp)
            existing = ClaudeErrorRecord.get(fp)
            if existing and not force:
                continue
            rec = ClaudeErrorRecord(
                fingerprint=fp,
                error_category=ErrorCategory.HOOK,
                error_msg=he.root_cause or f"{he.hook} ({he.event}) error",
                hook=he.hook,
                event=he.event,
                root_cause=he.root_cause,
                traceback=he.traceback,
                occurrence_count=1,
                first_seen=he.timestamp,
                last_seen=he.timestamp,
                session_ids=[self.session_id] if self.session_id else [],
                last_session_id=self.session_id or "",
                last_jsonl_path=jsonl_path,
                occurrences=[
                    {
                        "timestamp": he.timestamp,
                        "session_id": self.session_id,
                        "jsonl_path": jsonl_path,
                        "error_msg": he.root_cause,
                        "traceback": he.traceback,
                        "hook": he.hook,
                        "event": he.event,
                    }
                ],
            )
            rec.id = fp
            rec.name = (he.root_cause or f"{he.hook} ({he.event}) error")[:80]
            rec.save()

        # Log errors
        for le in log_errors:
            fp = _fingerprint_log(le.message)
            all_fps.append(fp)
            existing = ClaudeErrorRecord.get(fp)
            if existing and not force:
                continue
            rec = ClaudeErrorRecord(
                fingerprint=fp,
                error_category=ErrorCategory.LOG,
                error_msg=le.message,
                occurrence_count=1,
                first_seen=le.timestamp,
                last_seen=le.timestamp,
                session_ids=[self.session_id] if self.session_id else [],
                last_session_id=self.session_id or "",
                last_jsonl_path=jsonl_path,
                occurrences=[
                    {
                        "timestamp": le.timestamp,
                        "session_id": self.session_id,
                        "jsonl_path": jsonl_path,
                        "error_msg": le.message,
                        "traceback": [],
                    }
                ],
            )
            rec.id = fp
            rec.name = le.message[:80]
            rec.save()

        # Store fingerprint list in index under list_key="error_fingerprints"
        descriptor = type(self).__dict__.get("error_fingerprints")
        if descriptor is not None:
            entry = descriptor.to_index_entry(all_fps)
            index.set_property("error_fingerprints", entry)

        index.mark_discovered()
        index.save()
        return self


# --- Record List ---


@dataclass
class ClaudeSessionDebugLogRecordList:
    """Iterable collection of debug log records.

    Scans ``~/.claude/debug/*.txt``, optionally filtering by age.
    Only parses files that contain errors (hook errors or [ERROR] lines).

    Compatible with the ``ResourceRecordList`` iteration protocol
    used by the ``fs-records`` action.
    """

    list_path: Path | None = None
    hours: float = 168.0

    def __post_init__(self):
        if self.list_path is None:
            self.list_path = ClaudeSessionDebugLogRecord.debug_dir()

    def _candidate_files(self) -> list[Path]:
        """Return .txt files within the time window, newest first."""
        if not self.list_path or not self.list_path.is_dir():
            return []
        cutoff = time.time() - (self.hours * 3600)
        files = []
        for entry in os.scandir(self.list_path):
            if entry.name.endswith(".txt") and entry.stat().st_mtime >= cutoff:
                files.append(Path(entry.path))
        files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        return files

    def __iter__(self) -> Iterator[ClaudeSessionDebugLogRecord]:
        for path in self._candidate_files():
            if has_errors(path):
                yield ClaudeSessionDebugLogRecord.from_debug_file(path)

    def __len__(self) -> int:
        return sum(1 for _ in self)

    @property
    def records(self) -> list[ClaudeSessionDebugLogRecord]:
        return list(self)

    def get(self, uid: str) -> ClaudeSessionDebugLogRecord | None:
        """Load a specific session by ID."""
        if not self.list_path:
            return None
        path = self.list_path / f"{uid}.txt"
        if not path.exists():
            return None
        return ClaudeSessionDebugLogRecord.from_debug_file(path)


# --- Clear helpers ---


def clear_debug_errors() -> dict[str, Any]:
    """Delete all Claude debug logs and error records.

    Returns a summary dict with counts of deleted/truncated/skipped items.
    """
    import shutil

    from flow_sdk.fs_store.record import get_default_records_root
    from flow_sdk.fs_store.record_types import RecordType

    deleted_debug = 0
    truncated_debug = 0
    skipped_debug: list[str] = []

    # 1. Delete debug log files (~/.claude/debug/*.txt)
    debug_dir = ClaudeSessionDebugLogRecord.debug_dir()
    if debug_dir.is_dir():
        for entry in os.scandir(debug_dir):
            if not entry.name.endswith(".txt"):
                # Remove dangling symlinks
                p = Path(entry.path)
                if p.is_symlink() and not p.exists():
                    p.unlink()
                continue
            try:
                Path(entry.path).unlink()
                deleted_debug += 1
            except PermissionError:
                # File may be locked by a running session — truncate instead
                try:
                    Path(entry.path).write_text("")
                    truncated_debug += 1
                except OSError:
                    skipped_debug.append(entry.name)
            except OSError:
                skipped_debug.append(entry.name)

    # 2. Delete error records (~/.flow/records/claude_error/)
    deleted_errors = 0
    error_dir = get_default_records_root() / RecordType.CLAUDE_ERROR
    if error_dir.is_dir():
        for child in list(error_dir.iterdir()):
            try:
                if child.is_dir():
                    shutil.rmtree(child)
                else:
                    child.unlink()
                deleted_errors += 1
            except OSError:
                pass

    return {
        "deleted_debug_logs": deleted_debug,
        "truncated_debug_logs": truncated_debug,
        "skipped_debug_logs": skipped_debug,
        "deleted_error_records": deleted_errors,
    }


# --- Backward-compat aliases ---

ClaudeDebugLogFsRecord = ClaudeSessionDebugLogRecord  # backward compat
ClaudeDebugLogRecordList = ClaudeSessionDebugLogRecordList  # backward compat
