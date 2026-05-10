"""Convert Claude hook webhook payloads into ``FlowData`` carrying a typed
``ProcessEntry``.

Sibling of ``event_to_flowdata.py`` (live worker stdout) and the JSONL
replay path (``AgentTranscript``). All three deliver the same wrapper shape
to downstream consumers — the only difference is the wrapper's
``observation_kind`` (``hook_pre``/``hook_post``/``synthesized`` here vs.
``live`` for the worker stream vs. ``replay`` for JSONL).

Logger namespace:
``flow_sdk.builtin.agentic_process.cli_drivers.claude.hook_to_flowdata``.
"""

from __future__ import annotations

import logging
from typing import Any

from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataSource,
    FlowDataType,
    FlowElementType,
)
from flow_sdk.transcript_analyzer.synthesizers import synth_process_entry

logger = logging.getLogger(__name__)


def convert_hook_event(payload: dict[str, Any]) -> list[FlowData]:
    """Map a single hook webhook payload to one FlowData carrying a ProcessEntry.

    ``payload`` is the dict ``listen.handle_agent_hook`` builds for the global
    sniffer ingest — keys: ``webhook_type``, ``agent_hook_id``, ``hook_data``,
    ``hook_entry_id``, ``hook_metadata``, ``hook_file_path``.

    Returns a single-item list (one FlowData per hook event) or an empty
    list when ``payload`` is structurally invalid. Never raises.

    The FlowData carries:
    - ``process_entry``: typed entry (synthesized via ``synth_process_entry``)
      whose ``transcript_entry.id`` matches the corresponding live-stream
      observation's id (the dedup join key).
    - ``attributes``: only the envelope-level metadata consumers need to
      route the event (webhook-type, agent-hook-id, hook-entry-id,
      hook-file-path). All conversational data lives under
      ``process_entry.transcript_entry``.
    """
    if not isinstance(payload, dict):
        return []

    hook_data = payload.get("hook_data") if isinstance(payload.get("hook_data"), dict) else {}
    raw = hook_data.get("raw_hook_data") if isinstance(hook_data.get("raw_hook_data"), dict) else {}
    # Hook payloads sometimes nest the actual fields under raw_hook_data;
    # synthesizers expect a single flat dict so merge raw into hook_data
    # (raw wins because it's closer to the wire).
    merged = {**hook_data, **raw}

    process_entry = synth_process_entry(merged)

    attributes: dict[str, str] = {
        "element-type": FlowElementType.STATUS,
        "data-type": FlowDataType.OBJECT,
        "source": FlowDataSource.SNIFFER,
        "webhook-type": str(payload.get("webhook_type") or "agent_hook"),
        "subtype": str(merged.get("hook_event_name") or "unknown"),
    }
    if process_entry.observation_kind:
        attributes["observation-kind"] = process_entry.observation_kind
    tool_name = merged.get("tool_name")
    if tool_name:
        attributes["tool-name"] = str(tool_name)
    tool_use_id = merged.get("tool_use_id")
    if tool_use_id:
        attributes["tool-use-id"] = str(tool_use_id)
    transcript_path = merged.get("transcript_path")
    if transcript_path:
        attributes["transcript-path"] = str(transcript_path)
    session_id = merged.get("session_id")
    if session_id:
        attributes["session-id"] = str(session_id)
    agent_hook_id = payload.get("agent_hook_id")
    if agent_hook_id:
        attributes["agent-hook-id"] = str(agent_hook_id)
    hook_entry_id = payload.get("hook_entry_id")
    if hook_entry_id:
        attributes["hook-entry-id"] = str(hook_entry_id)
    hook_file_path = payload.get("hook_file_path")
    if hook_file_path:
        attributes["hook-file-path"] = str(hook_file_path)
    message = _first_string(merged, (
        "message",
        "assistant_message",
        "last_assistant_message",
        "user_message",
        "prompt",
    ))
    if message:
        attributes["hook-message"] = message
    error = _first_string(merged, ("error", "error_message"))
    if error:
        attributes["hook-error"] = error
    stop_reason = _first_string(merged, ("stop_reason",))
    if stop_reason:
        attributes["hook-stop-reason"] = stop_reason
    task_subject = _first_string(merged, ("task_subject",))
    if task_subject:
        attributes["hook-task-subject"] = task_subject
    tool_input = merged.get("tool_input")
    summary = _summarize_tool_input(tool_input)
    if summary:
        attributes["tool-input-summary"] = summary

    return [FlowData(
        flow_value=payload,
        attributes=attributes,
        process_entry=process_entry.to_dict(),
    )]


def _first_string(data: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _summarize_tool_input(tool_input: Any) -> str | None:
    if not isinstance(tool_input, dict):
        return None
    for key in ("command", "file_path", "pattern", "url", "query", "description", "prompt"):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            return value
    if tool_input:
        return str(tool_input)
    return None
