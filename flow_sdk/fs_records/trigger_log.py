"""Trigger log — fs_records-based data layer.

Each rule evaluation call is stored as an entry in a JSONL file.
Storage: ~/.flow/records/trigger_log/<rule_name>/calls.jsonl
"""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, ClassVar

from flow_sdk.config import FLOW_HOME
from flow_sdk.fs_store import Record
from flow_sdk.fs_store.record_types import RecordType

TRIGGER_LOG_DIR: Path = FLOW_HOME / "records" / "trigger_log"
MAX_ENTRIES = 1000
DROP_COUNT = 200


class TriggerLogRecord(Record):
    """A single trigger evaluation log entry.

    Entries live in per-rule JSONL files (not individual record folders).
    """

    _record_type: ClassVar[str] = RecordType.TRIGGER_LOG

    def __init__(self, **kwargs):
        kwargs.setdefault("type", RecordType.TRIGGER_LOG)
        kwargs.setdefault("id", str(uuid.uuid4()))
        if "created_at" not in kwargs:
            kwargs["created_at"] = datetime.now(timezone.utc).isoformat()
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    @staticmethod
    def _log_file(rule_name: str) -> Path:
        return TRIGGER_LOG_DIR / rule_name / "calls.jsonl"

    @staticmethod
    def append_entry(rule_name: str, entry_dict: dict[str, Any]) -> None:
        """Append a log entry for a rule. Caps at MAX_ENTRIES, drops DROP_COUNT oldest."""
        log_file = TriggerLogRecord._log_file(rule_name)
        log_file.parent.mkdir(parents=True, exist_ok=True)

        # Build full entry
        entry = {
            "id": entry_dict.get("id", str(uuid.uuid4())),
            "ts": entry_dict.get("ts", datetime.now(timezone.utc).isoformat()),
            "hook_event": entry_dict.get("hook_event", ""),
            "trigger": entry_dict.get("trigger", False),
            "reason": entry_dict.get("reason", ""),
            "is_test": entry_dict.get("is_test", False),
            "rule_name": entry_dict.get("rule_name", rule_name),
            "actions": entry_dict.get("actions", []),
            "agentic_process_id": entry_dict.get("agentic_process_id"),
        }

        # Read existing entries
        entries: list[str] = []
        if log_file.exists():
            try:
                entries = [ln for ln in log_file.read_text(encoding="utf-8").splitlines() if ln.strip()]
            except OSError:
                entries = []

        # Cap: drop oldest if over limit
        if len(entries) >= MAX_ENTRIES:
            entries = entries[DROP_COUNT:]

        entries.append(json.dumps(entry))
        log_file.write_text("\n".join(entries) + "\n", encoding="utf-8")

    @classmethod
    def discover(cls, scope=None, rule_name: str | None = None, limit: int = 500, **kwargs) -> list[dict[str, Any]]:
        """Read newest-first entries.

        When called directly with a rule name (legacy positional call), returns
        entries for that rule. When called generically by RecordList (scope=...),
        returns entries across all rules.
        """
        # Legacy direct call: TriggerLogRecord.discover("my_rule", limit=N)
        # In that case scope receives the rule name string.
        effective_rule = rule_name
        if effective_rule is None and isinstance(scope, str):
            effective_rule = scope

        if effective_rule is not None:
            return cls._discover_rule(effective_rule, limit)

        # Generic scan — return entries across all rules
        if not TRIGGER_LOG_DIR.exists():
            return []
        results: list[dict[str, Any]] = []
        for rule_dir in TRIGGER_LOG_DIR.iterdir():
            if rule_dir.is_dir():
                results.extend(cls._discover_rule(rule_dir.name, limit))
        return results

    @staticmethod
    def _discover_rule(rule_name: str, limit: int = 500) -> list[dict[str, Any]]:
        """Read newest-first entries for a single rule."""
        log_file = TriggerLogRecord._log_file(rule_name)
        if not log_file.exists():
            return []
        try:
            lines = [ln for ln in log_file.read_text(encoding="utf-8").splitlines() if ln.strip()]
        except OSError:
            return []

        result = []
        for line in reversed(lines[-limit:]):
            try:
                result.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return result
