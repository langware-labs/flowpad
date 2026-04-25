"""Pure field extractor functions for HookEventData."""

from __future__ import annotations

from typing import Optional

from flow_sdk.claude_hook_events.hook_event_data import HookEventData


def get_trigger_log_dock_pointer(
    hook_entry_id: Optional[str],
) -> Optional[dict]:
    """Compute a trigger log dock pointer from a hook entry ID.

    The hook entry ID is the trigger entity ID — the same value TriggerLogViewer
    uses as triggerId to fetch GET /trigger/{id}/log.

    Returns None when no hook entry ID is present.
    """
    if not hook_entry_id:
        return None
    return {"ref": hook_entry_id, "options": {}}


def _crop_text(text: str, max_words: int = 5) -> str:
    """Truncate text to a maximum number of words."""
    words = text.split()
    if len(words) <= max_words:
        return " ".join(words)
    return " ".join(words[:max_words]) + "..."


def extract_cwd(hook_data: HookEventData) -> str | None:
    """Extract the working directory from hook event data."""
    return hook_data.cwd


def extract_session_id(hook_data: HookEventData) -> str | None:
    """Extract the session ID from hook event data."""
    return hook_data.session_id


def extract_session_id_from_dict(hook_data: dict) -> str | None:
    """Extract session_id from a raw webhook hook_data dict.

    Walks the same precedence chain the UI hook uses
    (`ui/src/hooks/use-hooks-sniffer.ts:82-93`):
      1. ``hook_data.raw_hook_data.session_id``
      2. ``hook_data.session_id``
      3. ``hook_data.event.context.session_id`` (some payload shapes)

    Returns ``None`` when no session_id is present.
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
    """Extract the tool name from hook event data."""
    return hook_data.tool_name


def get_event_summary_line(hook_data: HookEventData) -> str:
    """Get a single-line plain-text summary for a hook event.

    Tool events: "ToolName: key-input-detail"
    Non-tool events: "EventName: detail"
    """
    tool_name = hook_data.tool_name
    tool_input = hook_data.tool_input
    event_name = hook_data.hook_event_name

    if tool_name:
        if tool_input:
            key_field = (
                tool_input.get("command")
                or tool_input.get("file_path")
                or tool_input.get("pattern")
                or tool_input.get("url")
                or tool_input.get("query")
                or tool_input.get("description")
                or tool_input.get("prompt")
                or ""
            )
            if isinstance(key_field, str) and key_field:
                return f"{tool_name}: {_crop_text(key_field)}"
        return tool_name

    if hook_data.message:
        return f"{event_name}: {_crop_text(hook_data.message)}"
    if hook_data.prompt:
        return f"{event_name}: {_crop_text(hook_data.prompt)}"
    if hook_data.notification_type:
        return f"{event_name}: {hook_data.notification_type}"
    if hook_data.agent_type:
        return f"{event_name}: {hook_data.agent_type}"
    if hook_data.reason:
        return f"{event_name}: {hook_data.reason}"
    if hook_data.task_subject:
        return f"{event_name}: {_crop_text(hook_data.task_subject)}"
    if hook_data.teammate_name:
        return f"{event_name}: {hook_data.teammate_name}"
    if hook_data.source:
        return f"{event_name}: {hook_data.source}"
    if hook_data.name:
        return f"{event_name}: {hook_data.name}"
    if hook_data.worktree_path:
        return f"{event_name}: {_crop_text(hook_data.worktree_path)}"

    return event_name or ""
