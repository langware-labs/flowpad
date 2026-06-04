"""Claude debug-log parsing — free functions, no Record subclass.

Source: ``<claude_home>/debug/<session-uuid>.txt`` — plain-text debug logs
containing hook errors (multi-line tracebacks) and ``[ERROR]`` log lines.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry

# CRUD-only type (no walker): records are produced on demand by parse_debug_log.
SchemaRegistry.register_crud_type(RecordType.CLAUDE_DEBUG_LOG, icon="Bug")


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
        return {"timestamp": self.timestamp, "message": self.message}


def parse_debug_log(path: Path) -> tuple[list[HookError], list[LogError]]:
    """Parse all hook errors and [ERROR] log lines in a single pass."""
    hook_errors: list[HookError] = []
    log_errors: list[LogError] = []
    current: HookError | None = None

    with open(path, "r", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")

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

            if current is not None:
                if _DEBUG_LINE.search(line) or _ERROR_LOG_LINE.match(line):
                    hook_errors.append(current)
                    current = None
                else:
                    if len(current.traceback) < 30:
                        current.traceback.append(line)
                        if _EXCEPTION_RE.match(line):
                            current.root_cause = line
                    continue

            em = _ERROR_LOG_LINE.match(line)
            if em:
                log_errors.append(LogError(timestamp=em.group(1), message=em.group(2)))

    if current is not None:
        hook_errors.append(current)
    return hook_errors, log_errors


def parse_hook_errors(path: Path) -> list[HookError]:
    """Parse only hook errors."""
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


def debug_dir() -> Path:
    """Return the platform-appropriate debug log directory."""
    d = get_instance_settings().claude_home / "debug"
    if d.is_dir():
        return d
    import sys
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            d = Path(appdata) / "claude" / "debug"
            if d.is_dir():
                return d
    return Path.home() / ".claude" / "debug"


def clear_debug_errors() -> dict[str, Any]:
    """Delete all Claude debug logs and error records.

    Returns a summary dict with counts of deleted/truncated/skipped items.
    """
    import shutil
    from flow_sdk.fs_store.record_paths import get_default_records_root
    from flow_sdk.fs_store.record_types import RecordType

    deleted_debug = 0
    truncated_debug = 0
    skipped_debug: list[str] = []

    d = debug_dir()
    if d.is_dir():
        for entry in os.scandir(d):
            if not entry.name.endswith(".txt"):
                p = Path(entry.path)
                if p.is_symlink() and not p.exists():
                    p.unlink()
                continue
            try:
                Path(entry.path).unlink()
                deleted_debug += 1
            except PermissionError:
                try:
                    Path(entry.path).write_text("")
                    truncated_debug += 1
                except OSError:
                    skipped_debug.append(entry.name)
            except OSError:
                skipped_debug.append(entry.name)

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
