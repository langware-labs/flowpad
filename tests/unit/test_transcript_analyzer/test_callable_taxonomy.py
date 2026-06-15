"""callable_taxonomy: vendor-neutral context/control/scope classification."""

from __future__ import annotations

import pytest

from flow_sdk.transcript_analyzer.callable_taxonomy import classify_callable

pytestmark = pytest.mark.timeout(5)


def test_skill_is_preserve_call_session():
    c = classify_callable("skill_call")
    assert c["context_policy"] == "preserve"
    assert c["control_policy"] == "call"
    assert c["state_scope"] == "session"
    assert c["mcp"] is False


def test_subagent_is_isolate_delegate():
    c = classify_callable("agent_spawn")
    assert c["context_policy"] == "isolate"
    assert c["control_policy"] == "delegate"


def test_compaction_is_compact_resume():
    c = classify_callable("compaction")
    assert c["context_policy"] == "compact"
    assert c["control_policy"] == "resume"


def test_tool_is_preserve_call_turn():
    c = classify_callable("shell_command")
    assert c == {"context_policy": "preserve", "control_policy": "call",
                 "state_scope": "turn", "mcp": False}


def test_mcp_tool_flagged():
    assert classify_callable("tool_use", "mcp__sentry__list_issues")["mcp"] is True
    assert classify_callable("tool_use", "Bash")["mcp"] is False


def test_taxonomy_maps_absent_primitives():
    # Mapped for stability even though no worker emits them today.
    assert classify_callable("handoff")["context_policy"] == "transfer"
    assert classify_callable("memory")["context_policy"] == "retrieve"
    assert classify_callable("workflow")["control_policy"] == "call"


def test_unknown_kind_defaults_to_tool_policy():
    assert classify_callable("something-new")["context_policy"] == "preserve"
