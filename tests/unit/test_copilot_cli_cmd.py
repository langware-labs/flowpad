"""Tests for GitHub Copilot CLI option construction."""

import sys

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import factory
from flow_sdk.builtin.agentic_process.cli_drivers.copilot import CopilotCliOptions


@pytest.fixture(autouse=True)
def force_posix(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")


def test_default_shell_string_uses_headless_json_stream():
    cmd = CopilotCliOptions(workdir="/repo")
    result = cmd.to_shell_string()

    assert result.startswith("cd /repo && copilot")
    assert "--output-format=json" in result
    assert "--stream=on" in result
    assert "--no-ask-user" in result
    assert "--allow-all" in result
    assert "-C /repo" in result


def test_spawn_args_support_session_id_resume_model_effort_and_add_dirs():
    cmd = CopilotCliOptions(
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
    cmd = CopilotCliOptions(model="lg", workdir="/repo")

    assert cmd.model == "lg"
    assert cmd.to_json()["model"] == "lg"

    argv, _env = cmd.to_spawn_args()
    assert argv[argv.index("--model") + 1] == "gpt-5.5"
    assert "--model gpt-5.5" in cmd.to_shell_string()


def test_fresh_session_id_uses_session_id_flag_not_resume():
    argv, _ = CopilotCliOptions(session_id="new-session").to_spawn_args()

    assert "--session-id" in argv
    assert "new-session" in argv
    assert "--resume=new-session" not in argv


def test_interactive_spawn_args_use_bare_copilot():
    cmd = CopilotCliOptions(
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
    assert env == {}


def test_to_json_roundtrip():
    cmd = CopilotCliOptions(
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
        allow_all=False,
    )
    loaded = CopilotCliOptions.from_json(cmd.to_json())

    assert loaded.session_id == "abc"
    assert loaded.resume is True
    assert loaded.model == "m"
    assert loaded.permission_mode == "default"
    assert loaded.effort == "medium"
    assert loaded.skill_names == ["reviewer"]
    assert loaded.workdir == "/repo"
    assert loaded.env_vars == {"X": "1"}
    assert loaded.add_dirs == ["/extra"]
    assert loaded.json_stream is False
    assert loaded.no_ask_user is False
    assert loaded.allow_all is False


def test_factory_returns_copilot_cli_cmd():
    cmd = factory({"resume": True, "session_id": "x"}, worker_type="copilot")

    assert isinstance(cmd, CopilotCliOptions)
    assert cmd.resume is True
    assert cmd.session_id == "x"
