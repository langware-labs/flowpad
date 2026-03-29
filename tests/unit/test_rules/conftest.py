"""Shared fixtures for rules tests."""

import json
import pytest
from pathlib import Path

from flow_sdk.hooks.types.hooks import HookEventType
from flow_sdk.rules import ActivationRule


def create_hook_data(
    hook_type: HookEventType,
    trigger_keyword: bool = True,
    dangerous: bool = False,
) -> dict:
    """Create hook data for the specified hook type."""
    keyword = "test_keyword" if trigger_keyword else "no_match"
    danger_suffix = " dangerous" if dangerous else ""

    base_data = {
        "hookEvent": hook_type.value,
        "session_id": "test-session-123",
        "transcript_path": "/tmp/transcript.json",
        "cwd": "/Users/test/project",
    }

    if hook_type == HookEventType.USER_PROMPT_SUBMIT:
        return {**base_data, "prompt": f"Please help with {keyword}{danger_suffix}"}
    elif hook_type == HookEventType.PRE_TOOL_USE:
        return {
            **base_data,
            "tool_name": "Bash",
            "tool_input": {"command": f"echo {keyword}{danger_suffix}"},
            "tool_use_id": "tool-use-001",
        }
    elif hook_type == HookEventType.POST_TOOL_USE:
        return {
            **base_data,
            "tool_name": "Bash",
            "tool_input": {"command": f"echo {keyword}"},
            "tool_response": {"output": "command output"},
            "tool_use_id": "tool-use-001",
        }
    elif hook_type == HookEventType.SESSION_START:
        return {**base_data, "source": f"cli_{keyword}" if trigger_keyword else "cli"}
    elif hook_type == HookEventType.STOP:
        return {
            **base_data,
            "stop_hook_active": True,
            "metadata": {"info": keyword} if trigger_keyword else {},
        }
    elif hook_type == HookEventType.NOTIFICATION:
        return {
            **base_data,
            "message": f"Notification: {keyword}" if trigger_keyword else "Info",
            "notification_type": "idle",
        }
    elif hook_type == HookEventType.SUBAGENT_STOP:
        return {
            **base_data,
            "agent_id": "agent-001",
            "agent_type": f"Explore_{keyword}" if trigger_keyword else "Explore",
            "agent_transcript_path": "/tmp/agent_transcript.json",
            "stop_hook_active": True,
        }
    elif hook_type == HookEventType.PRE_COMPACT:
        return {**base_data, "compact_info": keyword if trigger_keyword else "none"}
    elif hook_type == HookEventType.PERMISSION_REQUEST:
        return {**base_data, "permission_mode": "default", "request_info": keyword if trigger_keyword else "none"}
    else:
        return {**base_data, "data": keyword if trigger_keyword else "none"}


@pytest.fixture
def hook_data_factory():
    """Pytest fixture that returns the hook data factory function."""
    return create_hook_data


@pytest.fixture
def sample_rule_path() -> Path:
    """Path to the test_rule sample rule directory."""
    return Path(__file__).parent / "sample_rules" / "test_rule"


@pytest.fixture
def sample_rule(sample_rule_path: Path) -> ActivationRule:
    """Load ActivationRule from the sample rule directory."""
    rule = ActivationRule.load_record(sample_rule_path / "record.json")
    rule.path = str(sample_rule_path)
    return rule


@pytest.fixture
def sample_transcript() -> list[dict]:
    """Load sample transcript from resources/transcript.jsonl."""
    transcript_path = Path(__file__).parent / "resources" / "transcript.jsonl"
    entries = []
    with open(transcript_path) as f:
        for line in f:
            line = line.strip()
            if line:
                entries.append(json.loads(line))
    return entries
