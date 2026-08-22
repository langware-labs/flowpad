"""OpenCodeAgentOptions argv/flag construction.

Shapes are pinned against the real CLI surface of opencode 1.18.16
(``opencode run --help``), not against documentation.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import factory
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.cli import OpenCodeAgentOptions


@pytest.fixture(autouse=True)
def force_posix(monkeypatch):
    monkeypatch.setattr("sys.platform", "linux")


def test_headless_argv_shape():
    cmd = OpenCodeAgentOptions(workdir="/repo", model="openrouter/z-ai/glm-5.2")
    assert cmd.cli_cmd(instruction="hello") == [
        "opencode",
        "run",
        "--format",
        "json",
        "--auto",
        "--dir",
        "/repo",
        "--model",
        "openrouter/z-ai/glm-5.2",
        "--",
        "hello",
    ]


def test_interactive_argv_is_the_bare_tui():
    """PTY transport drops the ``run``/``--format json`` head entirely.

    The workdir switches spelling with the shape: ``opencode run`` has ``--dir``,
    but the bare TUI is ``opencode [project]`` — a positional. Verified against
    1.18.16: ``opencode --auto --dir /repo`` dumps usage and exits 1, so a
    ``--dir`` here would kill every PTY-mode worker at spawn.
    """
    cmd = OpenCodeAgentOptions(workdir="/repo", json_stream=False)
    argv = cmd.cli_cmd()
    assert argv[0] == "opencode"
    assert "run" not in argv
    assert "--format" not in argv
    assert "--dir" not in argv
    assert argv[1:] == ["--auto", "/repo"]


@pytest.mark.parametrize("flag", ["--dir", "--variant"])
def test_interactive_omits_run_only_flags(flag):
    """``--dir`` and ``--variant`` exist on ``opencode run`` but NOT on the TUI.

    Measured on 1.18.16: either one makes the bare TUI print usage and exit 1,
    which kills the PTY worker at spawn. The headless shape still carries both.
    """
    kwargs = {"workdir": "/repo", "variant": "high", "model": "openrouter/z-ai/glm-5.2"}
    assert flag not in OpenCodeAgentOptions(json_stream=False, **kwargs).cli_cmd()
    assert flag in OpenCodeAgentOptions(json_stream=True, **kwargs).cli_cmd(instruction="hi")


def test_never_emits_add_dir():
    """opencode has NO --add-dir; extra roots ride the generated config.

    This is the assertion that catches a copy-paste from copilot/cli.py.
    """
    cmd = OpenCodeAgentOptions(
        workdir="/repo",
        add_dirs=["/repo/assets", "/repo/more"],
    )
    argv = cmd.cli_cmd(instruction="hi")
    assert "--add-dir" not in argv
    assert "/repo/assets" not in argv


def test_resume_emits_session_and_fork():
    fresh = OpenCodeAgentOptions(workdir="/repo", session_id="ses_abc123")
    # Not resumable yet → no --session at all: opencode exits 1 on an unknown id.
    assert "--session" not in fresh.cli_cmd()

    resumed = OpenCodeAgentOptions(workdir="/repo", session_id="ses_abc123", resume=True)
    argv = resumed.cli_cmd()
    assert argv[argv.index("--session") + 1] == "ses_abc123"
    assert "--fork" not in argv

    forked = OpenCodeAgentOptions(
        workdir="/repo", session_id="ses_abc123", resume=True, fork_session_id="ses_parent"
    )
    forked_argv = forked.cli_cmd()
    # ``--fork`` is only legal alongside --session/--continue.
    assert "--fork" in forked_argv
    assert forked_argv.index("--session") < forked_argv.index("--fork")


def test_session_id_is_passed_through_verbatim():
    """``ses_…`` is a vendor id, not a UUID — nothing may coerce or validate it."""
    cmd = OpenCodeAgentOptions(workdir="/repo", session_id="ses_00f358da4ffei1Vz0U3dkTMQYX", resume=True)
    argv = cmd.cli_cmd()
    assert "ses_00f358da4ffei1Vz0U3dkTMQYX" in argv


def test_permission_mode_gates_auto():
    assert "--auto" in OpenCodeAgentOptions(workdir="/repo").cli_cmd()
    assert "--auto" not in OpenCodeAgentOptions(workdir="/repo", permission_mode="default").cli_cmd()


def test_model_tier_resolves_but_raw_intent_is_preserved():
    cmd = OpenCodeAgentOptions(workdir="/repo", model="sm")
    assert cmd.model == "sm"  # persisted intent stays portable
    assert cmd.resolved_model == "openrouter/z-ai/glm-4.7-flash"
    assert "openrouter/z-ai/glm-4.7-flash" in cmd.cli_cmd()


def test_concrete_model_passes_through():
    cmd = OpenCodeAgentOptions(workdir="/repo", model="openrouter/anthropic/claude-sonnet-latest")
    assert cmd.resolved_model == "openrouter/anthropic/claude-sonnet-latest"


def test_config_path_is_exported_as_opencode_config():
    """The generated config is opencode's only instruction channel."""
    cmd = OpenCodeAgentOptions(workdir="/repo", config_path="/shadow/opencode/opencode.json")
    _argv, env = cmd.to_spawn_args(instruction="hi")
    assert env["OPENCODE_CONFIG"] == "/shadow/opencode/opencode.json"


def test_shell_string_matches_argv():
    cmd = OpenCodeAgentOptions(workdir="/repo", model="openrouter/z-ai/glm-5.2")
    shell = cmd.to_shell_string(instruction="hello")
    assert shell.startswith("cd /repo && opencode run --format json --auto")
    assert "--model openrouter/z-ai/glm-5.2" in shell


def test_to_json_round_trip():
    cmd = OpenCodeAgentOptions(
        session_id="ses_abc",
        resume=True,
        model="md",
        workdir="/repo",
        add_dirs=["/repo/assets"],
        agent="plan",
        json_stream=False,
    )
    restored = OpenCodeAgentOptions.from_json(cmd.to_json())
    assert restored.to_json() == cmd.to_json()
    assert restored.json_stream is False
    assert restored.agent == "plan"


def test_factory_dispatches_opencode():
    built = factory({"workdir": "/repo", "model": "md"}, "opencode")
    assert isinstance(built, OpenCodeAgentOptions)
