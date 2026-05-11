"""Synthesize ``ProcessEntry`` from Claude hook payloads.

Hooks observe the same events the JSONL records, but at a different moment in
the lifecycle (PreToolUse fires *before* the JSONL line is written; PostToolUse
fires *after* the result is in). Each tool/prompt hook is reshaped into a
canonical ProcessEntry whose ``id`` matches the corresponding JSONL line's
content-block id, so cross-observation dedup just works.

For lifecycle hooks (SessionStart, WorktreeCreate, TaskCreated, …) there is no
underlying JSONL line — they describe events about the process, not entries
in its conversation. We synthesize a ``SystemEntry(subtype=hook_event_name)``
so HookData always carries a typed entry; consumers branch on
``entry.kind === 'system'`` rather than on ``entry is None``.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..entries import (
    SystemEntry,
    ToolResultEntry,
    ToolUseEntry,
    UserMessageEntry,
)
from ..entry import TranscriptEntry
from ..process_entry import ObservationKind, ProcessEntry

# Hook event names that map to a content-bearing ProcessEntry (vs. lifecycle).
_TOOL_USE_HOOKS = frozenset({"PreToolUse", "PermissionRequest"})
_TOOL_RESULT_HOOKS = frozenset({"PostToolUse", "PostToolUseFailure"})
_USER_MESSAGE_HOOKS = frozenset({"UserPromptSubmit"})


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _base_kwargs(hook_data: dict[str, Any]) -> dict[str, Any]:
    """Common envelope kwargs derived from the raw hook payload.

    The hook payload always carries ``session_id``; ``timestamp`` is
    fabricated at synthesis time when the hook didn't pass one through.
    """
    return {
        "id": hook_data.get("tool_use_id") or "",
        "session_id": str(hook_data.get("session_id") or ""),
        "timestamp": str(hook_data.get("timestamp") or _now_iso()),
        "worker": "claude",
    }


def synth_tool_use_entry(hook_data: dict[str, Any]) -> ToolUseEntry:
    """PreToolUse / PermissionRequest → ToolUseEntry.

    Carries the upcoming tool's name + input. The ``id`` is the
    ``tool_use_id`` Claude assigned (matches what the live stream + JSONL
    will publish for the same call).
    """
    base = _base_kwargs(hook_data)
    return ToolUseEntry(
        tool_name=str(hook_data.get("tool_name") or "unknown"),
        tool_use_id=str(hook_data.get("tool_use_id") or ""),
        tool_input=hook_data.get("tool_input") or {},
        **base,
    )


def synth_tool_result_entry(hook_data: dict[str, Any]) -> ToolResultEntry:
    """PostToolUse / PostToolUseFailure → ToolResultEntry.

    Carries the tool response. The ``id`` (= ``tool_use_id``) joins back to
    the prior ``tool_use`` observation.
    """
    base = _base_kwargs(hook_data)
    response = hook_data.get("tool_response")
    error = hook_data.get("error")
    if isinstance(response, str):
        content_text = response
    elif response is None:
        content_text = error or ""
    else:
        # Coerce dict / list → string for the renderer; consumers that need
        # the structured response should read ``hook_data.tool_response`` from
        # the envelope's ``extra``.
        try:
            import json
            content_text = json.dumps(response, ensure_ascii=False)
        except (TypeError, ValueError):
            content_text = str(response)
    return ToolResultEntry(
        tool_use_id=str(hook_data.get("tool_use_id") or ""),
        tool_output=content_text,
        is_error=bool(error),
        tool_name=str(hook_data.get("tool_name") or "") or None,
        **base,
    )


def synth_user_message_entry(hook_data: dict[str, Any]) -> UserMessageEntry:
    """UserPromptSubmit → UserMessageEntry."""
    base = _base_kwargs(hook_data)
    return UserMessageEntry(
        text=str(hook_data.get("prompt") or ""),
        role="user",
        **base,
    )


def synth_lifecycle_system_entry(hook_data: dict[str, Any]) -> SystemEntry:
    """Lifecycle hooks (SessionStart, WorktreeCreate, …) → SystemEntry.

    No content is observed — the hook merely announces a process event. The
    ``subtype`` is the hook_event_name so consumers can dispatch by it. The
    full hook payload is preserved in ``payload`` for surface-specific
    rendering.
    """
    base = _base_kwargs(hook_data)
    return SystemEntry(
        subtype=str(hook_data.get("hook_event_name") or "unknown"),
        payload={k: v for k, v in hook_data.items() if k not in ("session_id", "timestamp")},
        **base,
    )


def synth_transcript_entry(hook_data: dict[str, Any]) -> TranscriptEntry:
    """Dispatch a hook payload to the right TranscriptEntry synthesizer.

    Always returns a TranscriptEntry — the lifecycle synthesizer is the
    catch-all (returns SystemEntry). Callers never need to handle ``None``.
    """
    name = str(hook_data.get("hook_event_name") or "")
    if name in _TOOL_USE_HOOKS:
        return synth_tool_use_entry(hook_data)
    if name in _TOOL_RESULT_HOOKS:
        return synth_tool_result_entry(hook_data)
    if name in _USER_MESSAGE_HOOKS:
        return synth_user_message_entry(hook_data)
    return synth_lifecycle_system_entry(hook_data)


def synth_process_entry(hook_data: dict[str, Any]) -> ProcessEntry:
    """Dispatch a hook payload to a ProcessEntry-wrapped TranscriptEntry.

    The observation_kind is derived from the hook event name:
      - PreToolUse / PermissionRequest          → 'hook_pre'
      - PostToolUse / PostToolUseFailure        → 'hook_post'
      - UserPromptSubmit                        → 'hook_pre' (the user just submitted; observed before turn lands)
      - any lifecycle hook (SessionStart, etc.) → 'synthesized'
    """
    name = str(hook_data.get("hook_event_name") or "")
    transcript_entry = synth_transcript_entry(hook_data)
    if name in _TOOL_USE_HOOKS or name in _USER_MESSAGE_HOOKS:
        kind: ObservationKind = "hook_pre"
    elif name in _TOOL_RESULT_HOOKS:
        kind = "hook_post"
    else:
        kind = "synthesized"
    return ProcessEntry(transcript_entry=transcript_entry, observation_kind=kind)
