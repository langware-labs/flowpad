"""Tests for flow_sdk.hooks.types parsing utilities."""

from flow_sdk.hooks.types import (
    HookEventType,
    HookEvent,
    parse_tool_input,
    parse_tool_response,
    parse_raw_hook_data,
    parse_hook_data,
    parse_hook_payload,
    parse_usage,
    BashToolInput,
    GlobToolInput,
    ReadToolInput,
    WriteToolInput,
    EditToolInput,
    TaskToolInput,
    BashToolResponse,
    GlobToolResponse,
    ReadToolResponse,
    ReadFileContent,
    PreToolUseRawHookData,
    PostToolUseRawHookData,
    UserPromptSubmitRawHookData,
    SessionStartRawHookData,
    StopRawHookData,
    RawHookDataBase,
    HookData,
    AgentHookPayload,
    UsageInfo,
    is_bash_input,
    is_glob_input,
    is_pre_tool_use,
    is_post_tool_use,
    is_user_prompt_submit,
    is_session_start,
    is_stop,
)


# -- HookEventType --

def test_hook_event_type_values():
    assert HookEventType.USER_PROMPT_SUBMIT == "UserPromptSubmit"
    assert HookEventType.PRE_TOOL_USE == "PreToolUse"
    assert HookEventType.POST_TOOL_USE == "PostToolUse"
    assert HookEventType.SESSION_START == "SessionStart"
    assert HookEventType.STOP == "Stop"


def test_hook_event_dataclass():
    event = HookEvent(hook_event="PreToolUse", hook_name="test")
    assert event.hook_event == "PreToolUse"
    assert event.command is None


# -- parse_tool_input --

def test_parse_tool_input_bash():
    result = parse_tool_input("Bash", {"command": "ls -la", "description": "list files"})
    assert isinstance(result, BashToolInput)
    assert result.command == "ls -la"
    assert result.description == "list files"


def test_parse_tool_input_glob():
    result = parse_tool_input("Glob", {"pattern": "*.py", "path": "/src"})
    assert isinstance(result, GlobToolInput)
    assert result.pattern == "*.py"


def test_parse_tool_input_read():
    result = parse_tool_input("Read", {"file_path": "/tmp/test.py"})
    assert isinstance(result, ReadToolInput)
    assert result.file_path == "/tmp/test.py"


def test_parse_tool_input_write():
    result = parse_tool_input("Write", {"file_path": "/tmp/test.py", "content": "hello"})
    assert isinstance(result, WriteToolInput)
    assert result.content == "hello"


def test_parse_tool_input_edit():
    result = parse_tool_input("Edit", {"file_path": "/f.py", "old_string": "a", "new_string": "b"})
    assert isinstance(result, EditToolInput)
    assert result.old_string == "a"


def test_parse_tool_input_task():
    result = parse_tool_input("Task", {"prompt": "do it", "description": "test", "subagent_type": "Explore"})
    assert isinstance(result, TaskToolInput)
    assert result.subagent_type == "Explore"


def test_parse_tool_input_unknown():
    result = parse_tool_input("UnknownTool", {"foo": "bar"})
    assert isinstance(result, dict)
    assert result["foo"] == "bar"


def test_parse_tool_input_extra_fields_ignored():
    result = parse_tool_input("Bash", {"command": "ls", "extra_field": "ignored"})
    assert isinstance(result, BashToolInput)
    assert result.command == "ls"


# -- parse_tool_response --

def test_parse_tool_response_bash():
    result = parse_tool_response("Bash", {"stdout": "output", "stderr": ""})
    assert isinstance(result, BashToolResponse)
    assert result.stdout == "output"


def test_parse_tool_response_glob():
    result = parse_tool_response("Glob", {"filenames": ["a.py", "b.py"], "numFiles": 2})
    assert isinstance(result, GlobToolResponse)
    assert result.numFiles == 2


def test_parse_tool_response_read_nested():
    result = parse_tool_response("Read", {
        "type": "file",
        "file": {"filePath": "/tmp/f.py", "content": "hello", "numLines": 1},
    })
    assert isinstance(result, ReadToolResponse)
    assert isinstance(result.file, ReadFileContent)
    assert result.file.content == "hello"


def test_parse_tool_response_string():
    result = parse_tool_response("Bash", "raw string output")
    assert result == "raw string output"


def test_parse_tool_response_unknown():
    result = parse_tool_response("UnknownTool", {"data": "stuff"})
    assert isinstance(result, dict)


# -- parse_raw_hook_data --

def test_parse_raw_hook_data_pre_tool_use():
    result = parse_raw_hook_data({
        "session_id": "s1",
        "transcript_path": "/t",
        "cwd": "/c",
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "tool_input": {"command": "ls"},
        "tool_use_id": "tu1",
    })
    assert isinstance(result, PreToolUseRawHookData)
    assert result.tool_name == "Bash"


def test_parse_raw_hook_data_user_prompt():
    result = parse_raw_hook_data({
        "session_id": "s1",
        "transcript_path": "/t",
        "cwd": "/c",
        "hook_event_name": "UserPromptSubmit",
        "prompt": "hello",
    })
    assert isinstance(result, UserPromptSubmitRawHookData)
    assert result.prompt == "hello"


def test_parse_raw_hook_data_session_start():
    result = parse_raw_hook_data({
        "session_id": "s1",
        "transcript_path": "/t",
        "cwd": "/c",
        "hook_event_name": "SessionStart",
        "source": "cli",
    })
    assert isinstance(result, SessionStartRawHookData)
    assert result.source == "cli"


def test_parse_raw_hook_data_unknown():
    result = parse_raw_hook_data({
        "session_id": "s1",
        "transcript_path": "/t",
        "cwd": "/c",
        "hook_event_name": "UnknownEvent",
    })
    assert isinstance(result, RawHookDataBase)


# -- parse_usage --

def test_parse_usage():
    result = parse_usage({"input_tokens": 100, "output_tokens": 50})
    assert isinstance(result, UsageInfo)
    assert result.input_tokens == 100
    assert result.output_tokens == 50


def test_parse_usage_none():
    assert parse_usage(None) is None


# -- parse_hook_data --

def test_parse_hook_data():
    result = parse_hook_data({
        "hook_event_name": "PreToolUse",
        "session_id": "s1",
        "tool_name": "Bash",
        "tool_input": {"command": "ls"},
    })
    assert isinstance(result, HookData)
    assert result.hook_event_name == "PreToolUse"
    assert result.tool_name == "Bash"


# -- parse_hook_payload --

def test_parse_hook_payload():
    result = parse_hook_payload({
        "webhook_type": "agent_hook",
        "webhook_payload": {
            "agent_hook_id": "ah1",
            "hook_data": {
                "hook_event_name": "PreToolUse",
                "session_id": "s1",
                "tool_name": "Bash",
            },
            "hook_metadata": {
                "hook_file_path": "/h",
                "hook_name": "test_hook",
                "hook_command": "cmd",
            },
        },
    })
    assert isinstance(result, AgentHookPayload)
    assert result.webhook_type == "agent_hook"
    assert result.hook_data.tool_name == "Bash"
    assert result.hook_metadata.hook_name == "test_hook"


# -- Type guards --

def test_type_guards():
    bash = BashToolInput(command="ls")
    glob = GlobToolInput(pattern="*.py")
    assert is_bash_input(bash) is True
    assert is_bash_input(glob) is False
    assert is_glob_input(glob) is True

    pre = HookData(hook_event_name="PreToolUse", session_id="s1")
    post = HookData(hook_event_name="PostToolUse", session_id="s1")
    user = HookData(hook_event_name="UserPromptSubmit", session_id="s1")
    start = HookData(hook_event_name="SessionStart", session_id="s1")
    stop = HookData(hook_event_name="Stop", session_id="s1")

    assert is_pre_tool_use(pre) is True
    assert is_pre_tool_use(post) is False
    assert is_post_tool_use(post) is True
    assert is_user_prompt_submit(user) is True
    assert is_session_start(start) is True
    assert is_stop(stop) is True
