"""Trigger log — per-rule JSONL entries. Free functions.

Storage: ``<records_root>/trigger_log/<rule_name>/calls.jsonl``

A row is the DURABLE half of a trigger outcome; the ``trigger.*`` FlowEvent
emitted at the same moment is the LIVE half (see ``builtin/trigger_on_tag.py``).
``event_id`` is what makes them one fact rather than two: the row carries the
envelope's id, so a UI reading either side can join to the other. That is why
the adapter builds its envelope through ``make_tag_event`` — ``emit``'s
zero-subscriber fast path would leave ``event_id`` null whenever nobody
happened to be listening, and the join would silently work only half the time.

NOTE the shape of ``append_entry``: it copies a FIXED key set out of
``entry_dict`` and DROPS anything else without a word. A caller passing a key
that isn't listed below writes nothing and gets no error — which is exactly how
``tag_triggers`` came to claim for months that it embedded the full envelope
while persisting none of it. Add the key here first.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flow_sdk.api.api_types.identifier import mint_uuid
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
        "id": entry_dict.get("id", str(mint_uuid())),
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
        # ── bus alignment (docs/flow-events.md) ─────────────────────────────
        # `event_id` is the `trigger.*` envelope THIS ROW IS. The `cause_*`
        # trio describes the envelope that caused it (tag fires only) — three
        # lean scalars rather than the full `event.model_dump()`, because a
        # `graph_workflow.*` cause carries stdout tails and 1000 of those per
        # rule would sit on disk forever. Reconstruct from `cause_event_id`.
        "event_id": entry_dict.get("event_id"),
        "cause_event_id": entry_dict.get("cause_event_id"),
        "cause_tag": entry_dict.get("cause_tag"),
        "cause_target": entry_dict.get("cause_target"),
        "actor": entry_dict.get("actor"),
        "trigger_id": entry_dict.get("trigger_id"),
        "trigger_type": entry_dict.get("trigger_type"),
        # Why a fire did NOT happen: storm | confirm_failed | disabled |
        # self_loop. Null on a real fire.
        "reason_code": entry_dict.get("reason_code"),
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


#: How much of the tail to read when only the newest `limit` rows are wanted.
#: Sized so a 200-row page is satisfied in one read for typical rows; when it
#: isn't, we fall back to the whole file, so this is a fast path and never a
#: correctness bound.
_TAIL_BYTES = 256 * 1024


def _read_tail_lines(log_file: Path, limit: int) -> list[str]:
    """The last `limit` non-empty lines, without reading the whole file.

    These files run to ~1 MB (MAX_ENTRIES rows) and the events screen polls them
    every few seconds; `read_text()` on the whole file to keep `lines[-limit:]`
    threw away most of what it read. The first line of a tail read is usually
    partial, so it is dropped — unless we reached byte 0, where it is genuine.
    """
    try:
        size = log_file.stat().st_size
        with log_file.open("rb") as fh:
            if size > _TAIL_BYTES:
                fh.seek(size - _TAIL_BYTES)
            chunk = fh.read()
        lines = chunk.decode("utf-8", errors="ignore").splitlines()
        if size > _TAIL_BYTES:
            lines = lines[1:]
        lines = [ln for ln in lines if ln.strip()]
        if len(lines) >= limit or size <= _TAIL_BYTES:
            return lines
        # Rare: rows so large that the tail didn't cover a full page.
        return [ln for ln in log_file.read_text(encoding="utf-8").splitlines() if ln.strip()]
    except OSError:
        return []


def _discover_rule(rule_name: str, limit: int = 500) -> list[dict[str, Any]]:
    log_file = _log_file(rule_name)
    if not log_file.exists():
        return []
    lines = _read_tail_lines(log_file, limit)
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
    # The all-rules branch concatenates per-rule blocks, so it has to sort to
    # honour this function's "newest-first" contract — otherwise every
    # cross-rule caller repeats the sort or silently gets grouped-by-rule rows.
    results.sort(key=lambda e: str(e.get("ts") or ""), reverse=True)
    return results[:limit]
