"""CLI invocation log — JSONL-backed.

Each CLI invocation is appended as one JSON line to ``<logs>/cli.log.jsonl``.
Settings live in an ``FSRecord(type='cli_log_settings', id='local')`` shadow.

No Record subclasses: entries are plain dicts; the settings record is the
canonical ``FSRecord``.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.instance_settings import get_instance_settings


def _cli_log_dir() -> Path:
    return get_instance_settings().logs_dir


def _cli_log_file() -> Path:
    return _cli_log_dir() / "cli.log.jsonl"


MAX_ENTRIES = 800
DROP_COUNT = 300
MAX_OUTPUT_SIZE = 50_000  # truncate stdout/stderr to 50KB per entry

_SETTINGS_UID = "local"
_DATA_DEFAULTS: dict[str, Any] = {
    "workdir": "",
    "command": [],
    "exit_code": 0,
    "stdout": "",
    "stderr": "",
    "stdin": None,
    "level": "info",
    "duration_ms": 0,
}


# ── Entry helpers ─────────────────────────────────────────────────────────

class CliLogEntry(dict):
    """Plain dict wrapping a cli_log entry with attribute access for defaults."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__()
        self.setdefault("type", RecordType.CLI_LOG)
        self.setdefault("id", str(uuid.uuid4()))
        if "created_at" not in self:
            self["created_at"] = datetime.now(timezone.utc).isoformat()
        for k, v in kwargs.items():
            self[k] = v

    def __getattr__(self, name: str) -> Any:
        if name in self:
            return self[name]
        if name in _DATA_DEFAULTS:
            return _DATA_DEFAULTS[name]
        raise AttributeError(name)

    def __setattr__(self, name: str, value: Any) -> None:
        self[name] = value


# Back-compat alias (callers historically used CliLogRecord(...))
CliLogRecord = CliLogEntry


def append_entry(record: CliLogEntry | dict) -> None:
    """Append record as a JSONL line, then enforce cap."""
    try:
        _cli_log_dir().mkdir(parents=True, exist_ok=True)
        entry = dict(record) if not isinstance(record, dict) else record
        line = json.dumps(entry, default=str) + "\n"
        with open(_cli_log_file(), "a") as f:
            f.write(line)
        _enforce_cap()
    except Exception:
        pass


# Back-compat alias
write_entry = append_entry


def _enforce_cap() -> None:
    """If line count >= MAX_ENTRIES, keep last (MAX_ENTRIES - DROP_COUNT) lines."""
    try:
        log_file = _cli_log_file()
        with open(log_file, "r") as f:
            lines = f.readlines()
        if len(lines) < MAX_ENTRIES:
            return
        keep = lines[-(MAX_ENTRIES - DROP_COUNT):]
        tmp = log_file.with_suffix(".tmp")
        with open(tmp, "w") as f:
            f.writelines(keep)
        tmp.replace(log_file)
    except Exception:
        pass


def clear_log() -> int:
    """Delete all log entries. Returns the number of entries deleted."""
    try:
        log_file = _cli_log_file()
        if not log_file.exists():
            return 0
        with open(log_file, "r") as f:
            count = sum(1 for line in f if line.strip())
        log_file.unlink()
        return count
    except Exception:
        return 0


def read_entries(limit: int = 800) -> list[CliLogEntry]:
    """Read JSONL entries, newest-first."""
    try:
        log_file = _cli_log_file()
        if not log_file.exists():
            return []
        records: list[CliLogEntry] = []
        with open(log_file, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                    records.append(CliLogEntry(**raw))
                except Exception:
                    continue
        records.reverse()
        return records[:limit]
    except Exception:
        return []


# ── Settings (FSRecord-backed) ────────────────────────────────────────────


class _Settings:
    """Plain object with attribute access for cli_log settings."""

    __slots__ = ("level",)

    def __init__(self, level: str = "info") -> None:
        self.level = level


def load_settings() -> _Settings:
    """Load settings. Returns default ``level='info'`` when missing."""
    try:
        rec = FSRecord.load(RecordType.CLI_LOG_SETTINGS, _SETTINGS_UID)
        return _Settings(level=rec.__dict__.get("level", "info"))
    except FileNotFoundError:
        return _Settings()
    except Exception:
        return _Settings()


def save_settings(level: str) -> None:
    """Save settings to the cli_log_settings FSRecord shadow."""
    try:
        try:
            rec = FSRecord.load(RecordType.CLI_LOG_SETTINGS, _SETTINGS_UID)
        except FileNotFoundError:
            rec = FSRecord(type=RecordType.CLI_LOG_SETTINGS, id=_SETTINGS_UID, name="CLI Log Settings")
        rec.__dict__["level"] = level
        rec.save()
    except Exception:
        pass
