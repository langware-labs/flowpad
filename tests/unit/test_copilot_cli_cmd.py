"""Tests for GitHub Copilot CLI option construction."""

import sys

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import factory
from flow_sdk.builtin.agentic_process.cli_drivers.copilot import CopilotAgentOptions


@pytest.fixture(autouse=True)
def force_posix(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")


def test_default_shell_string_uses_headless_json_stream():
    cmd = CopilotAgentOptions(workdir="/repo")
    result = cmd.to_shell_string()

    assert result.startswith("cd /repo && copilot")
    assert "--output-format=json" in result
    assert "--stream=on" in result
    assert "--no-ask-user" in result
    assert "--allow-all" in result
    assert "-C /repo" in result


def test_spawn_args_support_session_id_resume_model_effort_and_add_dirs():
    cmd = CopilotAgentOptions(
        session_id="abc-123",
        resume=True,
        model="claude-haiku-4.5",
        effort="low",
        workdir="/repo",
        env_vars={"FOO": "bar"},
        add_dirs=["/extra"],
    )
    argv, env = cmd.to_spawn_args()

    assert argv == [
        "copilot",
        "--output-format=json",
        "--stream=on",
        "--no-ask-user",
        "--no-auto-update",
        "--no-custom-instructions",
        "--allow-all",
        "-C",
        "/repo",
        "--model",
        "claude-haiku-4.5",
        "--effort",
        "low",
        "--add-dir",
        "/extra",
        "--resume=abc-123",
    ]
    assert env == {"FOO": "bar"}


def test_model_tier_persists_raw_and_emits_resolved_model():
    cmd = CopilotAgentOptions(model="lg", workdir="/repo")

    assert cmd.model == "lg"
    assert cmd.to_json()["model"] == "lg"

    argv, _env = cmd.to_spawn_args()
    assert argv[argv.index("--model") + 1] == "gpt-5.5"
    assert "--model gpt-5.5" in cmd.to_shell_string()


def test_fresh_session_id_uses_session_id_flag_not_resume():
    argv, _ = CopilotAgentOptions(session_id="new-session").to_spawn_args()

    assert "--session-id" in argv
    assert "new-session" in argv
    assert "--resume=new-session" not in argv


def test_interactive_spawn_args_use_bare_copilot():
    cmd = CopilotAgentOptions(
        session_id="abc",
        resume=True,
        model="claude-haiku-4.5",
        workdir="/repo",
        json_stream=False,
    )
    argv, env = cmd.to_spawn_args()

    assert argv == [
        "copilot",
        "--allow-all",
        "-C",
        "/repo",
        "--model",
        "claude-haiku-4.5",
        "--resume=abc",
    ]
    assert env == {"COPILOT_ALLOW_ALL": "true"}


@pytest.mark.parametrize("json_stream", [False, True])
def test_process_plugin_dirs_are_repeatable_raw_runtime_flags(json_stream):
    plugin_dirs = ["/plugins/one", "/plugins/two with 'quotes' and \U0001f600"]
    cmd = CopilotAgentOptions(plugin_dirs=plugin_dirs, json_stream=json_stream)

    argv, _env = cmd.to_spawn_args()

    assert [argv[index + 1] for index, value in enumerate(argv[:-1]) if value == "--plugin-dir"] == plugin_dirs
    assert "plugin_dirs" not in cmd.to_json()
    assert CopilotAgentOptions.from_json({"plugin_dirs": ["/persisted"]}).plugin_dirs == []


def test_interactive_non_bypass_does_not_inject_folder_trust_override():
    cmd = CopilotAgentOptions(
        workdir="/repo",
        json_stream=False,
        permission_mode="default",
    )

    _argv, env = cmd.to_spawn_args()

    assert "COPILOT_ALLOW_ALL" not in env


def test_to_json_roundtrip():
    cmd = CopilotAgentOptions(
        session_id="abc",
        resume=True,
        model="m",
        permission_mode="default",
        effort="medium",
        skill_names=["reviewer"],
        workdir="/repo",
        env_vars={"X": "1"},
        add_dirs=["/extra"],
        json_stream=False,
        no_ask_user=False,
        no_auto_update=False,
        no_custom_instructions=False,
        allow_all=False,
        custom_instruction_dirs=["/runtime/instructions"],
    )
    cmd.fork_session_id = "launch-only-fork"
    cmd.system_prompt_append = "launch derived"
    cmd.system_prompt_file = "/tmp/system-prompt"
    data = cmd.to_json()
    loaded = CopilotAgentOptions.from_json(data)

    assert data == {
        "workdir": "/repo",
        "env_vars": {"X": "1"},
        "worker_type": "copilot",
        "session_id": "abc",
        "resume": True,
        "model": "m",
        "permission_mode": "default",
        "effort": "medium",
        "skill_names": ["reviewer"],
        "add_dirs": ["/extra"],
        "json_stream": False,
        "no_ask_user": False,
        "no_auto_update": False,
        "no_custom_instructions": False,
        "allow_all": False,
    }
    assert loaded.to_json() == data


def test_custom_instruction_dirs_are_runtime_only_and_preserve_existing_env(monkeypatch):
    monkeypatch.setenv("COPILOT_CUSTOM_INSTRUCTIONS_DIRS", "/global,/shared")
    cmd = CopilotAgentOptions(custom_instruction_dirs=["/shared", "/process"])

    _argv, env = cmd.to_spawn_args()

    assert env["COPILOT_CUSTOM_INSTRUCTIONS_DIRS"] == "/global,/shared,/process"
    assert "custom_instruction_dirs" not in cmd.to_json()


def test_factory_returns_copilot_cli_cmd():
    cmd = factory({"resume": True, "session_id": "x"}, worker_type="copilot")

    assert isinstance(cmd, CopilotAgentOptions)
    assert cmd.resume is True
    assert cmd.session_id == "x"
