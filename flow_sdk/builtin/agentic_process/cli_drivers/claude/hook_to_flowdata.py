"""Convert Claude hook webhook payloads into generic ``FlowData``.

Sibling of ``event_to_flowdata.py`` (live worker stdout) and
``session_history.py`` (transcript replay). All three produce the *same*
``FlowData`` shape so downstream consumers (``AgenticProcess.flowDataStream``,
the InteractiveTerminal TraceGutter, ``EntityChatPanel``) never have to know
which translator emitted them — they discriminate only on
``elementType`` + ``source``.

Hook events come from Claude Code's hook system (PreToolUse, PostToolUse,
UserPromptSubmit, SessionStart, Notification, …). They are *not* 1:1 with
the conversation events that history/live emit, so we deliberately keep them
on the ``STATUS`` element-type with rich attributes (``webhook-type``,
``subtype``, ``tool-name``, ``tool-use-id``, …). Mapping them to
``TOOL_CALL``/``TOOL_RESULT`` would dedup-collide with the worker's own live
events for the same tool and conflate "hook fired" with "tool invoked".

Logger namespace:
``flow_sdk.builtin.agentic_process.cli_drivers.claude.hook_to_flowdata``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataSource,
    FlowDataType,
    FlowElementType,
)

logger = logging.getLogger(__name__)


def convert_hook_event(payload: dict[str, Any]) -> list[FlowData]:
    """Map a single hook webhook payload to one or more FlowData items.

    ``payload`` is the dict that ``listen.handle_agent_hook`` already builds
    for the global sniffer ingest — keys: ``webhook_type``, ``agent_hook_id``,
    ``hook_data`` (the Claude hook's own dict), ``hook_entry_id``,
    ``hook_metadata``, ``hook_file_path``.

    Returns a single-item list (one FlowData per hook event). Returns an
    empty list when ``payload`` is structurally invalid — never raises.

    Surfaces hook-payload fields as canonical FlowData attributes so the UI
    renderers can read them without digging into ``hook_data.raw_hook_data.*``:

    * ``hook-message`` — first message-shaped string from the raw payload
      (``raw_hook_data.message`` / ``prompt`` / ``last_assistant_message``).
    * ``hook-error``, ``hook-stop-reason``, ``hook-task-subject``,
      ``hook-agent-type``, ``hook-teammate-name``, ``hook-source``,
      ``hook-name``, ``hook-worktree-path`` — common Claude-hook detail
      fields surfaced 1:1 from ``raw_hook_data``.
    * ``hook-file-path`` — the source ``hook_file_path`` from the webhook.
    * ``tool-input-summary`` — short string from ``hook_data.tool_input``
      (``command`` / ``file_path`` / ``pattern`` / ``query`` / ``url`` /
      ``code`` / ``prompt``) for one-line gutter summaries.
    """
    if not isinstance(payload, dict):
        return []

    hook_data = payload.get("hook_data") if isinstance(payload.get("hook_data"), dict) else {}
    raw = hook_data.get("raw_hook_data") if isinstance(hook_data.get("raw_hook_data"), dict) else {}
    tool_input = hook_data.get("tool_input") if isinstance(hook_data.get("tool_input"), dict) else {}

    hook_event_name = str(hook_data.get("hook_event_name") or raw.get("hook_event_name") or "")
    tool_name = str(hook_data.get("tool_name") or raw.get("tool_name") or "")
    tool_use_id = str(hook_data.get("tool_use_id") or raw.get("tool_use_id") or "")
    webhook_type = str(payload.get("webhook_type") or "agent_hook")
    transcript_path = str(hook_data.get("transcript_path") or raw.get("transcript_path") or "")

    attributes: dict[str, str] = {
        "element-type": FlowElementType.STATUS,
        "data-type": FlowDataType.OBJECT,
        "source": FlowDataSource.SNIFFER,
        "webhook-type": webhook_type,
        "t": datetime.now(timezone.utc).isoformat(),
    }
    if hook_event_name:
        attributes["subtype"] = hook_event_name
    if tool_name:
        attributes["tool-name"] = tool_name
    if tool_use_id:
        attributes["tool-use-id"] = tool_use_id
    if transcript_path:
        attributes["transcript-path"] = transcript_path
    agent_hook_id = payload.get("agent_hook_id")
    if agent_hook_id:
        attributes["agent-hook-id"] = str(agent_hook_id)
    hook_entry_id = payload.get("hook_entry_id")
    if hook_entry_id:
        attributes["hook-entry-id"] = str(hook_entry_id)
    hook_file_path = payload.get("hook_file_path")
    if hook_file_path:
        attributes["hook-file-path"] = str(hook_file_path)

    # Extract a one-line message preview from the raw Claude hook payload.
    # Mirrors the precedence the legacy ``getOneLiner`` walked in
    # event-utils.tsx: any *message-shaped* key (message, prompt, *_message)
    # wins, then specific named fields.
    message = ""
    for k in ("message", "prompt", "last_assistant_message"):
        v = raw.get(k)
        if isinstance(v, str) and v:
            message = v
            break
    if not message:
        for k in raw.keys():
            if "message" in k and isinstance(raw.get(k), str) and raw.get(k):
                message = str(raw[k])
                break
    if message:
        attributes["hook-message"] = message

    for raw_key, attr_key in (
        ("error", "hook-error"),
        ("stop_reason", "hook-stop-reason"),
        ("task_subject", "hook-task-subject"),
        ("agent_type", "hook-agent-type"),
        ("teammate_name", "hook-teammate-name"),
        ("source", "hook-source"),
        ("name", "hook-name"),
        ("worktree_path", "hook-worktree-path"),
    ):
        v = raw.get(raw_key)
        if isinstance(v, str) and v:
            attributes[attr_key] = v

    # Tool-input one-liner: precedence mirrors the legacy fallback chain.
    if isinstance(tool_input, dict):
        for k in ("command", "file_path", "pattern", "query", "url", "code", "prompt"):
            v = tool_input.get(k)
            if isinstance(v, str) and v:
                attributes["tool-input-summary"] = v
                break

    return [FlowData(flow_value=payload, attributes=attributes)]
