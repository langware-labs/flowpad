"""Tests for ClaudeCliOptions — all Claude CLI switch scenarios."""

import sys

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.claude import ClaudeCliOptions
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import factory


@pytest.fixture(autouse=True)
def force_posix(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")


# ─── Session / resume / fork ─────────────────────────────────────────────────


def test_fresh_session():
    cmd = ClaudeCliOptions(session_id="abc-123", resume=False, workdir="/p")
    result = cmd.to_shell_string()
    assert "--session-id" in result and "abc-123" in result
    assert "--resume" not in result


def test_resume_session():
    cmd = ClaudeCliOptions(session_id="abc-123", resume=True, workdir="/p")
    result = cmd.to_shell_string()
    assert "--resume" in result and "abc-123" in result
    assert "--session-id" not in result


def test_fork():
    cmd = ClaudeCliOptions(
        session_id="new-uuid",
        resume=True,
        fork_session_id="src-uuid",
        workdir="/p",
    )
    result = cmd.to_shell_string()
    assert "--resume" in result and "src-uuid" in result
    assert "--fork-session" in result
    assert "--session-id" in result and "new-uuid" in result


def test_fork_without_resume_does_not_produce_fork_flags():
    # fork_session_id is ignored if resume=False
    cmd = ClaudeCliOptions(
        session_id="new-uuid",
        resume=False,
        fork_session_id="src-uuid",
        workdir="/p",
    )
    result = cmd.to_shell_string()
    assert "--fork-session" not in result
    assert "--session-id" in result and "new-uuid" in result


def test_no_session_id():
    cmd = ClaudeCliOptions(session_id=None, resume=False, workdir="/p")
    result = cmd.to_shell_string()
    assert "--session-id" not in result
    assert "--resume" not in result


# ─── Debug ───────────────────────────────────────────────────────────────────


def test_debug_on():
    cmd = ClaudeCliOptions(session_id="s", debug=True, workdir="/p")
    assert "--debug" in cmd.to_shell_string()


def test_debug_off():
    cmd = ClaudeCliOptions(session_id="s", debug=False, workdir="/p")
    assert "--debug" not in cmd.to_shell_string()


# ─── Permissions ─────────────────────────────────────────────────────────────


def test_dangerously_skip_permissions():
    cmd = ClaudeCliOptions(session_id="s", permission_mode="bypassPermissions", workdir="/p")
    assert "--dangerously-skip-permissions" in cmd.to_shell_string()


def test_no_skip_permissions_for_other_modes():
    cmd = ClaudeCliOptions(session_id="s", permission_mode="default", workdir="/p")
    assert "--dangerously-skip-permissions" not in cmd.to_shell_string()


# ─── Model ───────────────────────────────────────────────────────────────────


def test_model():
    cmd = ClaudeCliOptions(session_id="s", model="claude-opus-4-5", workdir="/p")
    result = cmd.to_shell_string()
    assert "--model" in result and "claude-opus-4-5" in result


def test_model_tier_persists_raw_and_emits_resolved_model():
    cmd = ClaudeCliOptions(session_id="s", model="sm", workdir="/p")

    assert cmd.model == "sm"
    assert cmd.to_json()["model"] == "sm"

    argv, _env = cmd.to_spawn_args()
    assert argv[argv.index("--model") + 1] == "haiku"
    assert "--model haiku" in cmd.to_shell_string()


def test_no_model():
    cmd = ClaudeCliOptions(session_id="s", model=None, workdir="/p")
    assert "--model" not in cmd.to_shell_string()


# ─── Chrome / worktree ───────────────────────────────────────────────────────


def test_chrome():
    cmd = ClaudeCliOptions(session_id="s", chrome=True, workdir="/p")
    assert "--chrome" in cmd.to_shell_string()


def test_no_chrome():
    cmd = ClaudeCliOptions(session_id="s", chrome=False, workdir="/p")
    assert "--chrome" not in cmd.to_shell_string()


def test_worktree():
    cmd = ClaudeCliOptions(session_id="s", worktree=True, workdir="/p")
    assert "--worktree" in cmd.to_shell_string()


def test_no_worktree():
    cmd = ClaudeCliOptions(session_id="s", worktree=False, workdir="/p")
    assert "--worktree" not in cmd.to_shell_string()


# ─── Agents JSON ─────────────────────────────────────────────────────────────


def test_agents_json():
    agents = {"model": "claude-opus-4-5", "tools": ["read"]}
    cmd = ClaudeCliOptions(session_id="s", agents_json=agents, workdir="/p")
    result = cmd.to_shell_string()
    assert "--agents" in result
    # The JSON should be embedded (quoted)
    assert "claude-opus-4-5" in result


def test_no_agents_json():
    cmd = ClaudeCliOptions(session_id="s", agents_json=None, workdir="/p")
    assert "--agents" not in cmd.to_shell_string()


# ─── Instruction injection ───────────────────────────────────────────────────


def test_instruction_single_line():
    cmd = ClaudeCliOptions(session_id="s", workdir="/p")
    result = cmd.to_shell_string(instruction="fix the bug")
    assert "'fix the bug'" in result


def test_instruction_multiline_heredoc():
    cmd = ClaudeCliOptions(session_id="s", workdir="/p")
    result = cmd.to_shell_string(instruction="step one\nstep two")
    # Uses ANSI-C quoting ($'...') with \n escape for multiline args
    assert "$'" in result
    assert "step one" in result
    assert "step two" in result


def test_instruction_win32_base64(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    cmd = ClaudeCliOptions(session_id="s", workdir="C:\\proj")
    result = cmd.to_shell_string(instruction="do something")
    assert "FromBase64String" in result


def test_no_instruction_on_resume():
    # Instruction is passed as None when resuming; should not appear
    cmd = ClaudeCliOptions(session_id="s", resume=True, workdir="/p")
    result = cmd.to_shell_string(instruction=None)
    # Command should not end with any stray instruction text
    assert "None" not in result


def test_print_mode_adds_p_flag():
    cmd = ClaudeCliOptions(session_id="s", workdir="/p", print_mode=True)
    result = cmd.to_shell_string(instruction="fix the bug")
    assert " -p " in result


def test_no_print_mode_no_p_flag():
    cmd = ClaudeCliOptions(session_id="s", workdir="/p", print_mode=False)
    result = cmd.to_shell_string(instruction="fix the bug")
    assert " -p " not in result


# ─── CLAUDE_PROJECT_DIR ──────────────────────────────────────────────────────


def test_claude_project_dir_auto_added():
    cmd = ClaudeCliOptions(session_id="s", workdir="/my/project")
    assert cmd.env_vars.get("CLAUDE_PROJECT_DIR") == "/my/project"


def test_claude_project_dir_in_shell_string():
    cmd = ClaudeCliOptions(session_id="s", workdir="/my/project")
    result = cmd.to_shell_string()
    assert "CLAUDE_PROJECT_DIR=" in result and "/my/project" in result


def test_claude_project_dir_not_added_without_workdir():
    cmd = ClaudeCliOptions(session_id="s", workdir=None)
    assert "CLAUDE_PROJECT_DIR" not in cmd.env_vars


# ─── Runtime env via add_env ─────────────────────────────────────────────────


def test_add_env_appears_in_string():
    cmd = ClaudeCliOptions(session_id="s", workdir="/p")
    cmd.add_env("FLOWPAD_EXECUTION_SCOPE", '["x"]')
    result = cmd.to_shell_string()
    assert "FLOWPAD_EXECUTION_SCOPE=" in result


# ─── Serialisation / factory ─────────────────────────────────────────────────


def test_to_json_roundtrip():
    cmd = ClaudeCliOptions(
        session_id="abc",
        resume=True,
        fork_session_id="src",
        model="claude-opus-4-5",
        debug=False,
        permission_mode="default",
        chrome=True,
        worktree=True,
        agents_json={"k": "v"},
        workdir="/proj",
        env_vars={"X": "1"},
    )
    d = cmd.to_json()
    loaded = ClaudeCliOptions.from_json(d)
    assert loaded.session_id == "abc"
    assert loaded.resume is True
    assert loaded.fork_session_id == "src"
    assert loaded.model == "claude-opus-4-5"
    assert loaded.debug is False
    assert loaded.permission_mode == "default"
    assert loaded.chrome is True
    assert loaded.worktree is True
    assert loaded.agents_json == {"k": "v"}
    assert loaded.workdir == "/proj"


def test_factory_returns_claude_cli_cmd():
    cmd = factory({"resume": True, "session_id": "x"}, worker_type="claude")
    assert isinstance(cmd, ClaudeCliOptions)
    assert cmd.resume is True


def test_factory_unknown_type_raises():
    with pytest.raises(ValueError, match="Unknown worker_type"):
        factory({}, worker_type="docker")


def test_from_json_defaults():
    cmd = ClaudeCliOptions.from_json({})
    assert cmd.resume is False
    assert cmd.debug is False
    assert cmd.permission_mode == "bypassPermissions"
    assert cmd.chrome is False
    assert cmd.worktree is False
