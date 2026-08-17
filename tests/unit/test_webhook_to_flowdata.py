"""Unit tests for the dispatcher and the hook_op translator.

The dispatcher (`convert_webhook_event`) routes by `webhook_type` so the
``listen.py`` helpers (``_broadcast_to_sniffer``, ``_route_to_source_process``)
can stay vendor-neutral. The hook_op translator surfaces the fields the
``getEventIcon`` hook_op branch needs (``hook-op-event-name``).
"""

from __future__ import annotations

from flow_sdk.app.actions._webhook_to_flowdata import (
    convert_hook_op_event,
    convert_webhook_event,
)
from flow_sdk.builtin.agentic_process.cli_drivers.claude.hook_to_flowdata import (
    convert_hook_event,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowDataSource,
    FlowDataType,
    FlowElementType,
)


def test_hook_op_event_surfaces_event_attrs() -> None:
    payload = {
        "webhook_type": "hook_op",
        "type": "rule",
        "operation": "event",
        "id": "r-1",
        "data": {"event_name": "rules_executed"},
    }
    fds = convert_hook_op_event(payload)
    assert len(fds) == 1
    fd = fds[0]
    assert fd.element_type == FlowElementType.STATUS
    assert fd.attributes["source"] == FlowDataSource.SNIFFER
    assert fd.attributes["webhook-type"] == "hook_op"
    assert fd.attributes["subtype"] == "rules_executed"
    assert fd.attributes["hook-op-event-name"] == "rules_executed"
    assert fd.attributes["hook-op-operation"] == "event"
    assert fd.attributes["hook-op-record-type"] == "rule"
    assert fd.attributes["hook-op-id"] == "r-1"


def test_hook_op_event_minimal_payload() -> None:
    fds = convert_hook_op_event({"webhook_type": "hook_op", "type": "skill", "operation": "create", "id": "s-1"})
    assert len(fds) == 1
    fd = fds[0]
    assert fd.attributes["webhook-type"] == "hook_op"
    assert fd.attributes["hook-op-operation"] == "create"
    assert fd.attributes["hook-op-record-type"] == "skill"
    # Optional fields not present for non-event ops.
    assert "subtype" not in fd.attributes


def test_hook_op_invalid_payload_returns_empty() -> None:
    assert convert_hook_op_event(None) == []  # type: ignore[arg-type]
    assert convert_hook_op_event("not a dict") == []  # type: ignore[arg-type]


def test_dispatcher_routes_agent_hook() -> None:
    payload = {
        "webhook_type": "agent_hook",
        "agent_hook_id": "h",
        "hook_data": {"hook_event_name": "PreToolUse", "tool_name": "Read"},
    }
    fds = convert_webhook_event(payload)
    # Should match what convert_hook_event returns for the same input.
    direct = convert_hook_event(payload)
    assert len(fds) == 1 and len(direct) == 1
    assert fds[0].attributes["subtype"] == direct[0].attributes["subtype"] == "PreToolUse"


def test_dispatcher_routes_hook_op() -> None:
    payload = {"webhook_type": "hook_op", "type": "rule", "operation": "event", "id": "x", "data": {"event_name": "rules_executed"}}
    fds = convert_webhook_event(payload)
    assert len(fds) == 1
    assert fds[0].attributes["subtype"] == "rules_executed"


def test_dispatcher_unknown_webhook_emits_status() -> None:
    fds = convert_webhook_event({"webhook_type": "mystery"})
    # Defensive STATUS so the wire stays continuous.
    assert len(fds) == 1
    fd = fds[0]
    assert fd.element_type == FlowElementType.STATUS
    assert fd.attributes["webhook-type"] == "mystery"


def test_convert_hook_event_surfaces_hook_message_attrs() -> None:
    """Tier-3 attribute extension on convert_hook_event.

    The hook-message / hook-error / hook-stop-reason / hook-task-subject /
    tool-input-summary attributes let renderers stop digging into
    `event.hook_data.raw_hook_data.*`.
    """
    payload = {
        "webhook_type": "agent_hook",
        "agent_hook_id": "h",
        "hook_file_path": "/path/to/hook.sh",
        "hook_data": {
            "hook_event_name": "Notification",
            "tool_name": "Bash",
            "tool_input": {"command": "ls -la /tmp"},
            "raw_hook_data": {
                "message": "Hello from the model",
                "stop_reason": "end_turn",
                "task_subject": "Run tests",
            },
        },
    }
    fd = convert_hook_event(payload)[0]
    assert fd.attributes["hook-message"] == "Hello from the model"
    assert fd.attributes["hook-stop-reason"] == "end_turn"
    assert fd.attributes["hook-task-subject"] == "Run tests"
    assert fd.attributes["hook-file-path"] == "/path/to/hook.sh"
    assert fd.attributes["tool-input-summary"] == "ls -la /tmp"


def test_convert_hook_event_message_precedence_chain() -> None:
    """`message` wins over other *_message keys; falls back to `prompt`."""
    payload_with_message = {
        "webhook_type": "agent_hook",
        "agent_hook_id": "h",
        "hook_data": {
            "hook_event_name": "UserPromptSubmit",
            "raw_hook_data": {"message": "primary", "last_assistant_message": "secondary"},
        },
    }
    fd = convert_hook_event(payload_with_message)[0]
    assert fd.attributes["hook-message"] == "primary"

    payload_with_prompt_only = {
        "webhook_type": "agent_hook",
        "agent_hook_id": "h",
        "hook_data": {"raw_hook_data": {"prompt": "fallback prompt"}},
    }
    fd2 = convert_hook_event(payload_with_prompt_only)[0]
    assert fd2.attributes["hook-message"] == "fallback prompt"


def test_data_type_default_when_data_type_attribute_absent() -> None:
    """Defensive: a hook payload should always produce data-type=object."""
    fd = convert_hook_op_event({"webhook_type": "hook_op", "type": "x", "operation": "y", "id": "z"})[0]
    assert fd.attributes["data-type"] == FlowDataType.OBJECT
