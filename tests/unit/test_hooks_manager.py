"""
Unit tests for Agent Hooks and Triggers functionality.

Migrated from FlowPad: flowpad/hub/tests/unit/test_hooks_manager.py
Adapted for flow-cli:
- Uses flow-cli import paths (no flowpad.hub.*)
- No DB persistence (pure in-memory model tests)
- No grant_role / multi-user (single @local user model)
"""

import pytest

from flow_sdk.builtin.agent_hook import AgentHook, AgentProvider, HookEventType, HookScope
from flow_sdk.builtin.hook_models import ActionType, HookEventData, TriggerAction
from flow_sdk.builtin.trigger import Trigger


def test_create_agent_hook_model():
    """Test creating an AgentHook model (no DB)."""
    hook = AgentHook(
        name="User Prompt Hook",
        description="Captures all user prompts",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event=HookEventType.USER_PROMPT_SUBMIT,
        enabled=True,
    )

    assert hook.name == "User Prompt Hook"
    assert hook.provider == AgentProvider.CLAUDE_CODE
    assert hook.hook_scope == HookScope.USER
    assert hook.event == HookEventType.USER_PROMPT_SUBMIT
    assert hook.enabled is True


def test_create_trigger_model():
    """Test creating a Trigger model (no DB)."""
    trigger = Trigger(
        name="Tool Use Trigger",
        description="Matches all tool use events",
        mask={"hook_event_name": "PreToolUse"},
        action=TriggerAction(action_type=ActionType.NOP),
        enabled=True,
    )

    assert trigger.name == "Tool Use Trigger"
    assert trigger.mask == {"hook_event_name": "PreToolUse"}
    assert trigger.action.action_type == ActionType.NOP
    assert trigger.enabled is True
    assert trigger.counter == 0


def test_trigger_matching():
    """Test trigger mask matching logic."""
    # Create trigger that matches UserPromptSubmit events
    trigger = Trigger(
        name="Prompt Trigger",
        mask={"hook_event_name": "UserPromptSubmit"},
        action=TriggerAction(action_type=ActionType.NOP),
        enabled=True,
    )

    # Test matching event
    matching_event = HookEventData(
        hook_event_name="UserPromptSubmit",
        prompt="Hello world",
    )
    assert trigger.match(matching_event) is True

    # Test non-matching event
    non_matching_event = HookEventData(
        hook_event_name="PreToolUse",
        tool_name="Read",
    )
    assert trigger.match(non_matching_event) is False


def test_trigger_matching_with_tool_name():
    """Test trigger matching with multiple mask criteria."""
    # Create trigger that matches PreToolUse events for Read tool
    trigger = Trigger(
        name="Read Tool Trigger",
        mask={"hook_event_name": "PreToolUse", "tool_name": "Read"},
        action=TriggerAction(action_type=ActionType.NOP),
        enabled=True,
    )

    # Test matching event
    matching_event = HookEventData(
        hook_event_name="PreToolUse",
        tool_name="Read",
        tool_input={"file_path": "/test.txt"},
    )
    assert trigger.match(matching_event) is True

    # Test event with different tool
    non_matching_event = HookEventData(
        hook_event_name="PreToolUse",
        tool_name="Write",
        tool_input={"file_path": "/test.txt"},
    )
    assert trigger.match(non_matching_event) is False


def test_disabled_trigger_does_not_match():
    """Test that disabled triggers do not match."""
    trigger = Trigger(
        name="Disabled Trigger",
        mask={"hook_event_name": "UserPromptSubmit"},
        action=TriggerAction(action_type=ActionType.NOP),
        enabled=False,
    )

    event = HookEventData(hook_event_name="UserPromptSubmit", prompt="Test")
    assert trigger.match(event) is False


def test_trigger_empty_mask_matches_all():
    """Test that an empty mask matches any event."""
    trigger = Trigger(
        name="Catch All Trigger",
        mask={},
        action=TriggerAction(action_type=ActionType.NOP),
        enabled=True,
    )

    event = HookEventData(hook_event_name="UserPromptSubmit", prompt="Test")
    assert trigger.match(event) is True


def test_trigger_mask_with_nonexistent_key_does_not_match():
    """Test that a mask with a key not in the event data does not match."""
    trigger = Trigger(
        name="Bad Key Trigger",
        mask={"nonexistent_key": "some_value"},
        action=TriggerAction(action_type=ActionType.NOP),
        enabled=True,
    )

    event = HookEventData(hook_event_name="UserPromptSubmit", prompt="Test")
    assert trigger.match(event) is False


def test_hook_event_types():
    """Test that all expected HookEventType values are present.

    Based on Claude Code hooks documentation:
    https://code.claude.com/docs/en/hooks
    """
    # Session lifecycle
    assert HookEventType.SESSION_START == "SessionStart"
    assert HookEventType.SESSION_END == "SessionEnd"

    # User interaction
    assert HookEventType.USER_PROMPT_SUBMIT == "UserPromptSubmit"
    assert HookEventType.NOTIFICATION == "Notification"

    # Tool events
    assert HookEventType.PRE_TOOL_USE == "PreToolUse"
    assert HookEventType.POST_TOOL_USE == "PostToolUse"
    assert HookEventType.POST_TOOL_USE_FAILURE == "PostToolUseFailure"
    assert HookEventType.PERMISSION_REQUEST == "PermissionRequest"

    # Agent stop/start
    assert HookEventType.STOP == "Stop"
    assert HookEventType.SUBAGENT_START == "SubagentStart"
    assert HookEventType.SUBAGENT_STOP == "SubagentStop"

    # Agent teams
    assert HookEventType.TEAMMATE_IDLE == "TeammateIdle"
    assert HookEventType.TASK_CREATED == "TaskCreated"
    assert HookEventType.TASK_COMPLETED == "TaskCompleted"

    # Configuration
    assert HookEventType.CONFIG_CHANGE == "ConfigChange"

    # Worktree
    assert HookEventType.WORKTREE_CREATE == "WorktreeCreate"
    assert HookEventType.WORKTREE_REMOVE == "WorktreeRemove"

    # Compaction
    assert HookEventType.PRE_COMPACT == "PreCompact"
    assert HookEventType.POST_COMPACT == "PostCompact"

    # Agent stop failure
    assert HookEventType.STOP_FAILURE == "StopFailure"

    # Configuration
    assert HookEventType.INSTRUCTIONS_LOADED == "InstructionsLoaded"

    # MCP elicitation
    assert HookEventType.ELICITATION == "Elicitation"
    assert HookEventType.ELICITATION_RESULT == "ElicitationResult"

    # File system
    assert HookEventType.CWD_CHANGED == "CwdChanged"
    assert HookEventType.FILE_CHANGED == "FileChanged"

    assert len(HookEventType) == 25


def test_hook_scope_values():
    """Test HookScope enum values."""
    assert HookScope.USER == "user"
    assert HookScope.PROJECT == "project"
    assert HookScope.LOCAL == "local"


def test_agent_provider_values():
    """Test AgentProvider enum values."""
    assert AgentProvider.CLAUDE_CODE == "claude_code"


def test_action_type_values():
    """Test ActionType enum values."""
    assert ActionType.NOP == "nop"
    assert ActionType.NOTIFY_ENTITY == "notify_entity"


def test_trigger_action_model():
    """Test TriggerAction model creation."""
    # NOP action
    nop_action = TriggerAction(action_type=ActionType.NOP)
    assert nop_action.action_type == ActionType.NOP

    # NOTIFY_ENTITY action
    notify_action = TriggerAction(action_type=ActionType.NOTIFY_ENTITY)
    assert notify_action.action_type == ActionType.NOTIFY_ENTITY


def test_hook_event_data_model():
    """Test HookEventData model creation and serialization."""
    event = HookEventData(
        hook_event_name="PreToolUse",
        tool_name="Read",
        tool_input={"file_path": "/test.txt"},
    )

    assert event.hook_event_name == "PreToolUse"
    assert event.tool_name == "Read"
    assert event.tool_input == {"file_path": "/test.txt"}

    # Test model_dump
    dumped = event.model_dump(exclude_none=False)
    assert dumped["hook_event_name"] == "PreToolUse"
    assert dumped["tool_name"] == "Read"
