"""Pure field extractor functions for HookEventData.

Phase 9: HookEventData carries `process_entry` (typed) + `extra` (raw payload
spillover) instead of 30+ flat optional fields. These helpers read from both
seams transparently.
"""

from __future__ import annotations

from typing import Any, Optional

from flow_sdk.claude_hook_events.hook_event_data import HookEventData


def get_trigger_log_dock_pointer(
    hook_entry_id: Optional[str],
) -> Optional[dict]:
    """Compute a trigger log dock pointer from a hook entry ID."""
    if not hook_entry_id:
        return None
    return {"ref": hook_entry_id, "options": {}}


def _crop_text(text: str, max_words: int = 5) -> str:
    words = text.split()
    if len(words) <= max_words:
        return " ".join(words)
    return " ".join(words[:max_words]) + "..."


def _extra(hook_data: HookEventData, key: str) -> Any:
    """Read a variant-specific field that used to be a flat HookEventData
    attribute and now lives in ``extra``."""
    return (hook_data.extra or {}).get(key)


def extract_cwd(hook_data: HookEventData) -> str | None:
    return hook_data.cwd


def extract_session_id(hook_data: HookEventData) -> str | None:
    return hook_data.session_id


def extract_session_id_from_dict(hook_data: dict) -> str | None:
    """Extract session_id from a raw webhook hook_data dict.

    Walks the same precedence chain the UI hook uses:
      1. hook_data.raw_hook_data.session_id
      2. hook_data.session_id
      3. hook_data.event.context.session_id
    """
    if not isinstance(hook_data, dict):
        return None
    raw = hook_data.get("raw_hook_data") if isinstance(hook_data.get("raw_hook_data"), dict) else None
    if raw and raw.get("session_id"):
        return str(raw["session_id"]) or None
    if hook_data.get("session_id"):
        return str(hook_data["session_id"]) or None
    event = hook_data.get("event") if isinstance(hook_data.get("event"), dict) else None
    context = event.get("context") if event and isinstance(event.get("context"), dict) else None
    if context and context.get("session_id"):
        return str(context["session_id"]) or None
    return None


def get_tool_name(hook_data: HookEventData) -> str | None:
    """Read tool_name from process_entry (typed) or extra (raw)."""
    if hook_data.process_entry:
        te = hook_data.process_entry.get("transcript_entry") or {}
        if te.get("tool_name"):
            return str(te["tool_name"])
    return _extra(hook_data, "tool_name")


def get_event_summary_line(hook_data: HookEventData) -> str:
    """One-line plain-text summary for a hook event."""
    event_name = hook_data.hook_event_name

    tool_name = get_tool_name(hook_data)
    tool_input = _extra(hook_data, "tool_input")
    if hook_data.process_entry and not tool_input:
        te = hook_data.process_entry.get("transcript_entry") or {}
        tool_input = te.get("tool_input")

    if tool_name:
        if isinstance(tool_input, dict) and tool_input:
            for k in ("command", "file_path", "pattern", "url", "query", "description", "prompt"):
                v = tool_input.get(k)
                if isinstance(v, str) and v:
                    return f"{tool_name}: {_crop_text(v)}"
        return tool_name

    for k in ("message", "prompt", "notification_type", "agent_type", "reason",
              "task_subject", "teammate_name", "source", "name", "worktree_path"):
        v = _extra(hook_data, k)
        if isinstance(v, str) and v:
            return f"{event_name}: {_crop_text(v)}"

    return event_name or ""
