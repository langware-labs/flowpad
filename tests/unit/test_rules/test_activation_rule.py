"""Unit tests for trigger loading and execution across all Claude hook types."""

import pytest
from pathlib import Path

from flow_sdk.rules import ActivationRule, TriggerResult, Action
from flow_sdk.hooks.types.hooks import HookEventType


def test_load_rule_from_folder(sample_rule: ActivationRule):
    """Verify ActivationRule loads correctly from record.json."""
    assert sample_rule is not None
    assert sample_rule.name == "test_rule"
    assert sample_rule.is_valid()
    assert sample_rule.description != ""


def test_run_with_user_prompt_submit(sample_rule, sample_transcript, hook_data_factory):
    """Test UserPromptSubmit hook triggers add_context action."""
    hook_data = hook_data_factory(HookEventType.USER_PROMPT_SUBMIT)
    result = sample_rule.run(hook_data, sample_transcript)

    assert isinstance(result, TriggerResult)
    assert result.trigger is True
    assert result.reason != ""
    assert len(result.actions) >= 1
    assert result.actions[0].type == "add_context"
    assert "content" in result.actions[0].params


def test_run_with_pre_tool_use(sample_rule, sample_transcript, hook_data_factory):
    """Test PreToolUse hook with Bash command triggers correctly."""
    hook_data = hook_data_factory(HookEventType.PRE_TOOL_USE)
    result = sample_rule.run(hook_data, sample_transcript)

    assert isinstance(result, TriggerResult)
    assert result.trigger is True
    assert len(result.actions) >= 1
    assert result.actions[0].type == "add_context"


def test_run_with_pre_tool_use_block(sample_rule, sample_transcript, hook_data_factory):
    """Test PreToolUse with dangerous command triggers block action."""
    hook_data = hook_data_factory(HookEventType.PRE_TOOL_USE, dangerous=True)
    result = sample_rule.run(hook_data, sample_transcript)

    assert isinstance(result, TriggerResult)
    assert result.trigger is True
    assert len(result.actions) >= 1
    assert result.actions[0].type == "block"
    assert "reason" in result.actions[0].params


def test_run_with_post_tool_use(sample_rule, sample_transcript, hook_data_factory):
    """Test PostToolUse hook processing."""
    hook_data = hook_data_factory(HookEventType.POST_TOOL_USE)
    result = sample_rule.run(hook_data, sample_transcript)

    assert isinstance(result, TriggerResult)
    assert result.trigger is True
    assert len(result.actions) >= 1


def test_run_with_session_start(sample_rule, sample_transcript, hook_data_factory):
    """Test SessionStart hook."""
    hook_data = hook_data_factory(HookEventType.SESSION_START)
    result = sample_rule.run(hook_data, sample_transcript)

    assert isinstance(result, TriggerResult)
    assert result.trigger is True


def test_run_with_stop(sample_rule, sample_transcript, hook_data_factory):
    """Test Stop hook."""
    hook_data = hook_data_factory(HookEventType.STOP)
    result = sample_rule.run(hook_data, sample_transcript)
    assert isinstance(result, TriggerResult)


def test_run_with_notification(sample_rule, sample_transcript, hook_data_factory):
    """Test Notification hook."""
    hook_data = hook_data_factory(HookEventType.NOTIFICATION)
    result = sample_rule.run(hook_data, sample_transcript)

    assert isinstance(result, TriggerResult)
    assert result.trigger is True


def test_run_with_subagent_stop(sample_rule, sample_transcript, hook_data_factory):
    """Test SubagentStop hook."""
    hook_data = hook_data_factory(HookEventType.SUBAGENT_STOP)
    result = sample_rule.run(hook_data, sample_transcript)

    assert isinstance(result, TriggerResult)
    assert result.trigger is True


def test_run_no_trigger(sample_rule, sample_transcript, hook_data_factory):
    """Test that non-matching input returns trigger=False."""
    hook_data = hook_data_factory(HookEventType.USER_PROMPT_SUBMIT, trigger_keyword=False)
    result = sample_rule.run(hook_data, sample_transcript)

    assert isinstance(result, TriggerResult)
    assert result.trigger is False
    assert len(result.actions) == 0


def test_action_validation_add_context(sample_rule, sample_transcript, hook_data_factory):
    """Validate add_context action has correct type and params."""
    hook_data = hook_data_factory(HookEventType.USER_PROMPT_SUBMIT)
    result = sample_rule.run(hook_data, sample_transcript)

    assert result.trigger is True
    action = result.actions[0]
    assert isinstance(action, Action)
    assert action.type == "add_context"
    assert "content" in action.params
    assert isinstance(action.params["content"], str)
    assert len(action.params["content"]) > 0


def test_action_validation_block(sample_rule, sample_transcript, hook_data_factory):
    """Validate block action has correct type and params."""
    hook_data = hook_data_factory(HookEventType.PRE_TOOL_USE, dangerous=True)
    result = sample_rule.run(hook_data, sample_transcript)

    assert result.trigger is True
    action = result.actions[0]
    assert isinstance(action, Action)
    assert action.type == "block"
    assert "reason" in action.params
    assert isinstance(action.params["reason"], str)


def test_run_with_empty_transcript(sample_rule, hook_data_factory):
    """Test that rule runs correctly with empty transcript."""
    hook_data = hook_data_factory(HookEventType.USER_PROMPT_SUBMIT)
    result = sample_rule.run(hook_data, transcript=[])

    assert isinstance(result, TriggerResult)
    assert result.trigger is True


def test_run_with_none_transcript(sample_rule, hook_data_factory):
    """Test that rule runs correctly with None transcript."""
    hook_data = hook_data_factory(HookEventType.USER_PROMPT_SUBMIT)
    result = sample_rule.run(hook_data, transcript=None)

    assert isinstance(result, TriggerResult)
    assert result.trigger is True


def test_trigger_result_to_dict(sample_rule, hook_data_factory):
    """Test TriggerResult.to_dict() produces valid structure."""
    hook_data = hook_data_factory(HookEventType.USER_PROMPT_SUBMIT)
    result = sample_rule.run(hook_data)
    result_dict = result.to_dict()

    assert isinstance(result_dict, dict)
    assert "trigger" in result_dict
    assert "reason" in result_dict
    assert "actions" in result_dict
    assert isinstance(result_dict["actions"], list)


def test_action_to_dict(sample_rule, hook_data_factory):
    """Test Action.to_dict() produces valid structure."""
    hook_data = hook_data_factory(HookEventType.USER_PROMPT_SUBMIT)
    result = sample_rule.run(hook_data)
    action = result.actions[0]
    action_dict = action.to_dict()

    assert isinstance(action_dict, dict)
    assert "type" in action_dict
    assert action_dict["type"] == "add_context"
