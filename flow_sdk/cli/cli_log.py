"""CLI invocation log — fs_records-based data layer.

Each CLI invocation is stored as a CliLogRecord (Record subclass) in a JSONL file.
Log file: ~/.flow/logs/cli.log.jsonl
Settings: stored as a CliLogSettingsRecord via standard fs_records discover/save.
"""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, ClassVar

from flow_sdk.fs_store import Record
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.scope import Scope
from flow_sdk.instance_settings import get_instance_settings

# ---------------------------------------------------------------------------
# Paths — call-time, via InstanceSettings (the single source of truth).
# ---------------------------------------------------------------------------


def _cli_log_dir() -> Path:
    return get_instance_settings().logs_dir


def _cli_log_file() -> Path:
    return _cli_log_dir() / "cli.log.jsonl"

MAX_ENTRIES = 800
DROP_COUNT = 300
MAX_OUTPUT_SIZE = 50_000  # truncate stdout/stderr to 50KB per entry

# Stable uid for the singleton settings record
_SETTINGS_UID = "local"


# ---------------------------------------------------------------------------
# CliLogRecord
# ---------------------------------------------------------------------------

class CliLogRecord(Record):
    """A single CLI invocation log entry.

    Meta fields (auto-handled by Record): id, type, created_at
    Data fields: workdir, command, exit_code, stdout, stderr, stdin,
                 level, duration_ms

    Entries live in a JSONL file (not individual record folders), so
    discover/get are overridden to read from the JSONL.
    The record is read-only through the fs-records action.
    """

    _record_type: ClassVar[str] = RecordType.CLI_LOG

    # Data fields that default to None / sensible values when absent
    _DATA_DEFAULTS: ClassVar[dict[str, Any]] = {
        "workdir": "",
        "command": [],
        "exit_code": 0,
        "stdout": "",
        "stderr": "",
        "stdin": None,
        "level": "info",
        "duration_ms": 0,
    }

    def __init__(self, **kwargs):
        kwargs.setdefault("type", RecordType.CLI_LOG)
        kwargs.setdefault("id", str(uuid.uuid4()))
        if "created_at" not in kwargs:
            kwargs["created_at"] = datetime.now(timezone.utc)
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    def __getattr__(self, name: str) -> Any:
        """Fall back to _DATA_DEFAULTS for known fields missing from _data."""
        try:
            return super().__getattr__(name)
        except AttributeError:
            if name in self._DATA_DEFAULTS:
                return self._DATA_DEFAULTS[name]
            raise

    @classmethod
    def discover(cls, scope: Scope | None = None, **kwargs: Any) -> list["CliLogRecord"]:
        """Read all entries from the JSONL log file, newest-first."""
        return read_entries(limit=kwargs.get("limit", MAX_ENTRIES))

    @classmethod
    def get(cls, uid: str, scope: Scope | None = None, **kwargs: Any) -> "CliLogRecord | None":
        """Find a single entry by id in the JSONL log file."""
        for rec in read_entries():
            if rec.id == uid:
                return rec
        return None


# ---------------------------------------------------------------------------
# CliLogSettingsRecord — singleton fs_record (uid="local")
# ---------------------------------------------------------------------------

class CliLogSettingsRecord(Record):
    """CLI log settings stored as a standard fs_record.

    Singleton at: ~/.flow/records/cli_log_settings/cli_log_settings-@local/
    Data fields: level ("info" | "debug")
    """

    _record_type: ClassVar[str] = RecordType.CLI_LOG_SETTINGS

    _DATA_DEFAULTS: ClassVar[dict[str, Any]] = {
        "level": "info",
    }

    def __init__(self, **kwargs):
        kwargs.setdefault("type", RecordType.CLI_LOG_SETTINGS)
        kwargs.setdefault("id", _SETTINGS_UID)
        kwargs.setdefault("name", "CLI Log Settings")
        super().__init__(**kwargs)

    def __getattr__(self, name: str) -> Any:
        try:
            return super().__getattr__(name)
        except AttributeError:
            if name in self._DATA_DEFAULTS:
                return self._DATA_DEFAULTS[name]
            raise


def load_settings() -> CliLogSettingsRecord:
    """Load settings record from disk. Returns defaults if missing."""
    try:
        rec = CliLogSettingsRecord.get(_SETTINGS_UID)
        if rec is not None:
            return rec
    except Exception:
        pass
    return CliLogSettingsRecord()


def save_settings(level: str) -> None:
    """Save settings record to disk."""
    try:
        rec = CliLogSettingsRecord.get(_SETTINGS_UID) or CliLogSettingsRecord()
        rec.level = level
        rec.save()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# JSONL read / write / cap
# ---------------------------------------------------------------------------

def write_entry(record: CliLogRecord) -> None:
    """Append record as a JSONL line, then enforce cap."""
    try:
        _cli_log_dir().mkdir(parents=True, exist_ok=True)
        line = json.dumps(record.meta_dict(), default=str) + "\n"
        with open(_cli_log_file(), "a") as f:
            f.write(line)
        _enforce_cap()
    except Exception:
        pass


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


def read_entries(limit: int = 800) -> list[CliLogRecord]:
    """Read JSONL entries as CliLogRecord instances, newest-first."""
    try:
        log_file = _cli_log_file()
        if not log_file.exists():
            return []
        records: list[CliLogRecord] = []
        with open(log_file, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(CliLogRecord.from_dict(json.loads(line)))
                except Exception:
                    continue
        records.reverse()
        return records[:limit]
    except Exception:
        return []
