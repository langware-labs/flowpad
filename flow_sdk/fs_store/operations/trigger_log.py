"""Trigger log — per-rule JSONL entries. Free functions.

Storage: ``<records_root>/trigger_log/<rule_name>/calls.jsonl``
"""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flow_sdk.instance_settings import get_instance_settings


MAX_ENTRIES = 1000
DROP_COUNT = 200


def _trigger_log_dir() -> Path:
    return get_instance_settings().records_root / "trigger_log"


def _log_file(rule_name: str) -> Path:
    return _trigger_log_dir() / rule_name / "calls.jsonl"


def append_entry(rule_name: str, entry_dict: dict[str, Any]) -> None:
    """Append a log entry for a rule. Caps at MAX_ENTRIES, drops DROP_COUNT oldest."""
    log_file = _log_file(rule_name)
    log_file.parent.mkdir(parents=True, exist_ok=True)

    entry = {
        "id": entry_dict.get("id", str(uuid.uuid4())),
        "ts": entry_dict.get("ts", datetime.now(timezone.utc).isoformat()),
        "hook_event": entry_dict.get("hook_event", ""),
        "event_kind": entry_dict.get("event_kind"),
        "changed_path": entry_dict.get("changed_path"),
        "change_type": entry_dict.get("change_type"),
        "changes": entry_dict.get("changes"),
        "changes_total": entry_dict.get("changes_total"),
        "changes_truncated": entry_dict.get("changes_truncated"),
        "trigger": entry_dict.get("trigger", False),
        "reason": entry_dict.get("reason", ""),
        "is_test": entry_dict.get("is_test", False),
        "rule_name": entry_dict.get("rule_name", rule_name),
        "actions": entry_dict.get("actions", []),
        "agentic_process_id": entry_dict.get("agentic_process_id"),
    }

    entries: list[str] = []
    if log_file.exists():
        try:
            entries = [ln for ln in log_file.read_text(encoding="utf-8").splitlines() if ln.strip()]
        except OSError:
            entries = []

    if len(entries) >= MAX_ENTRIES:
        entries = entries[DROP_COUNT:]
    entries.append(json.dumps(entry))
    log_file.write_text("\n".join(entries) + "\n", encoding="utf-8")


def _discover_rule(rule_name: str, limit: int = 500) -> list[dict[str, Any]]:
    log_file = _log_file(rule_name)
    if not log_file.exists():
        return []
    try:
        lines = [ln for ln in log_file.read_text(encoding="utf-8").splitlines() if ln.strip()]
    except OSError:
        return []
    result: list[dict[str, Any]] = []
    for line in reversed(lines[-limit:]):
        try:
            result.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return result


def discover(rule_name: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
    """Read newest-first entries.

    When ``rule_name`` is given, returns entries for that rule. Otherwise
    returns entries across all rules.
    """
    if rule_name is not None:
        return _discover_rule(rule_name, limit)
    log_dir = _trigger_log_dir()
    if not log_dir.exists():
        return []
    results: list[dict[str, Any]] = []
    for rule_dir in log_dir.iterdir():
        if rule_dir.is_dir():
            results.extend(_discover_rule(rule_dir.name, limit))
    return results
