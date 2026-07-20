"""Tests for CodexCliOptions — Codex CLI switch and spawn scenarios."""

import sys

import pytest

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 compatibility
    import tomli as tomllib

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import factory
from flow_sdk.builtin.agentic_process.cli_drivers.codex import CodexCliOptions


@pytest.fixture(autouse=True)
def force_posix(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")


def test_default_shell_string_uses_headless_json_exec():
    cmd = CodexCliOptions(workdir="/repo")
    result = cmd.to_shell_string()

    assert result.startswith("cd /repo && codex exec")
    assert "--skip-git-repo-check" in result
    assert "--dangerously-bypass-approvals-and-sandbox" in result
    assert "--ephemeral" in result
    assert "--json" in result
    assert "-c model_reasoning_effort=low" in result
    assert "-C /repo" in result


def test_permission_mode_default_omits_bypass_flag():
    cmd = CodexCliOptions(permission_mode="default", workdir="/repo")
    result = cmd.to_shell_string()

    assert "--dangerously-bypass-approvals-and-sandbox" not in result


def test_model_add_dirs_resume_and_skills_in_shell_string():
    cmd = CodexCliOptions(
        session_id="abc-123",
        resume=True,
        model="gpt-5.2",
        workdir="/repo with space",
        add_dirs=["/extra/a", "/extra b"],
        skill_names=["reviewer", "bug fixer"],
    )
    result = cmd.to_shell_string()

    assert "cd '/repo with space'" in result
    assert "-m gpt-5.2" in result
    assert "--add-dir /extra/a" in result
    assert "--add-dir '/extra b'" in result
    assert "resume abc-123" in result
    assert "# skill=reviewer" in result
    assert "# skill='bug fixer'" in result


def test_model_tier_persists_raw_and_emits_resolved_model():
    cmd = CodexCliOptions(model="sm", workdir="/repo")

    assert cmd.model == "sm"
    assert cmd.to_json()["model"] == "sm"

    argv, _env = cmd.to_spawn_args()
    assert argv[argv.index("-m") + 1] == "gpt-5.4-mini"
    assert "-m gpt-5.4-mini" in cmd.to_shell_string()


def test_json_spawn_args_read_prompt_from_stdin():
    cmd = CodexCliOptions(
        session_id="abc-123",
        resume=True,
        model="gpt-5.2",
        workdir="/repo",
        env_vars={"FOO": "bar"},
        add_dirs=["/extra"],
    )
    argv, env = cmd.to_spawn_args()

    assert argv == [
        "codex",
        "exec",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "--ephemeral",
        "--json",
        "-c",
        "model_reasoning_effort=low",
        "-C",
        "/repo",
        "-m",
        "gpt-5.2",
        "--add-dir",
        "/extra",
        "resume",
        "abc-123",
        "-",
    ]
    assert env == {"FOO": "bar"}


def test_interactive_spawn_args_use_bare_codex():
    cmd = CodexCliOptions(
        session_id="abc-123",
        resume=True,
        model="gpt-5.2",
        workdir="/repo",
        add_dirs=["/extra"],
        json_stream=False,
        ephemeral=False,
    )
    argv, env = cmd.to_spawn_args()

    assert argv == [
        "codex",
        "--dangerously-bypass-approvals-and-sandbox",
        "-c",
        "check_for_update_on_startup=false",
        "-c",
        'projects={"/repo"={trust_level="trusted"}}',
        "-c",
        "model_reasoning_effort=low",
        "-C",
        "/repo",
        "-m",
        "gpt-5.2",
        "--add-dir",
        "/extra",
        "resume",
        "abc-123",
    ]
    assert env == {}


def test_interactive_spawn_respects_non_bypass_permissions():
    cmd = CodexCliOptions(
        permission_mode="default",
        json_stream=False,
        ephemeral=False,
    )
    argv, _ = cmd.to_spawn_args()

    assert argv == [
        "codex",
        "-c",
        "check_for_update_on_startup=false",
        "-c",
        "model_reasoning_effort=low",
    ]


@pytest.mark.parametrize(
    "workdir",
    [
        "/repo",
        '/repo.with.dots/space and "quotes"/back\\slash/emoji-🧪',
        "/repo/control-\x7f-name",
    ],
)
def test_interactive_trust_override_encodes_exact_workdir_as_toml_data(workdir):
    cmd = CodexCliOptions(
        workdir=workdir,
        json_stream=False,
        ephemeral=False,
    )
    argv, _ = cmd.to_spawn_args()

    override = next(arg for arg in argv if arg.startswith("projects="))
    assert tomllib.loads(override) == {
        "projects": {workdir: {"trust_level": "trusted"}},
    }


def test_interactive_trust_override_uses_canonical_existing_workdir(tmp_path):
    real_workdir = tmp_path / "real.project"
    real_workdir.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(real_workdir, target_is_directory=True)

    argv, _ = CodexCliOptions(
        workdir=str(alias),
        json_stream=False,
        ephemeral=False,
    ).to_spawn_args()

    override = next(arg for arg in argv if arg.startswith("projects="))
    assert tomllib.loads(override) == {
        "projects": {str(real_workdir.resolve()): {"trust_level": "trusted"}},
    }


def test_headless_bypass_does_not_add_interactive_trust_override():
    argv, _ = CodexCliOptions(workdir="/repo").to_spawn_args()

    assert not any("trust_level" in arg for arg in argv)
    assert "check_for_update_on_startup=false" not in argv


def test_interactive_non_bypass_does_not_add_trust_override():
    argv, _ = CodexCliOptions(
        permission_mode="default",
        workdir="/repo",
        json_stream=False,
        ephemeral=False,
    ).to_spawn_args()

    assert not any("trust_level" in arg for arg in argv)
    assert "check_for_update_on_startup=false" in argv


def test_pty_shell_string_uses_bare_codex_not_codex_exec():
    """``to_shell_string()`` for ``json_stream=False`` (PTY/visible mode) must
    mirror ``to_spawn_args()`` — bare ``codex`` interactive TUI, NOT
    ``codex exec --json …``. Regression: previously ``_build_worker_args``
    always emitted the headless shape so ``cmd_line`` lied about the launch
    command on every PTY codex tab.
    """
    cmd = CodexCliOptions(
        workdir="/repo",
        model="gpt-5.2",
        add_dirs=["/extra"],
        json_stream=False,
        ephemeral=False,
    )
    result = cmd.to_shell_string()

    # Bare codex, no `exec` subcommand — matches to_spawn_args().
    assert "codex --dangerously-bypass-approvals-and-sandbox" in result
    assert "codex exec" not in result
    # Headless-only flags must NOT leak into the PTY cmd_line.
    assert "--skip-git-repo-check" not in result
    assert "--ephemeral" not in result
    assert "--json" not in result
    # Reasoning-effort override applies on BOTH transports (04a07cf9), so the
    # PTY shell mirrors to_spawn_args and carries it too.
    assert "-c model_reasoning_effort=low" in result
    assert "-c check_for_update_on_startup=false" in result
    # User-set settings still flow through.
    assert "-m gpt-5.2" in result
    assert "-C /repo" in result
    assert "--add-dir /extra" in result


def test_pty_shell_string_matches_spawn_argv_token_for_token():
    """Stronger invariant: ``to_shell_string`` must contain the same tokens
    (after shell-quoting) as ``to_spawn_args``. Catches future drift."""
    import shlex

    cmd = CodexCliOptions(
        workdir="/path with space",
        model="gpt-5.2",
        json_stream=False,
        ephemeral=False,
    )
    argv, _ = cmd.to_spawn_args()
    expected_tail = " ".join(shlex.quote(a) for a in argv)
    assert cmd.to_shell_string().endswith(expected_tail)


def test_to_json_roundtrip():
    cmd = CodexCliOptions(
        session_id="abc",
        resume=True,
        model="gpt-5.2",
        permission_mode="default",
        skill_names=["reviewer"],
        workdir="/repo",
        env_vars={"X": "1"},
        add_dirs=["/extra"],
        json_stream=False,
        ephemeral=False,
    )
    loaded = CodexCliOptions.from_json(cmd.to_json())

    assert loaded.session_id == "abc"
    assert loaded.resume is True
    assert loaded.model == "gpt-5.2"
    assert loaded.permission_mode == "default"
    assert loaded.skill_names == ["reviewer"]
    assert loaded.workdir == "/repo"
    assert loaded.env_vars == {"X": "1"}
    assert loaded.add_dirs == ["/extra"]
    assert loaded.json_stream is False
    assert loaded.ephemeral is False


def test_factory_returns_codex_cli_cmd():
    cmd = factory({"resume": True, "session_id": "x"}, worker_type="codex")

    assert isinstance(cmd, CodexCliOptions)
    assert cmd.resume is True
    assert cmd.session_id == "x"


def test_from_json_defaults():
    cmd = CodexCliOptions.from_json({})

    assert cmd.session_id is None
    assert cmd.resume is False
    assert cmd.model is None
    assert cmd.permission_mode == "bypassPermissions"
    assert cmd.skill_names == []
    assert cmd.workdir is None
    assert cmd.env_vars == {}
    assert cmd.add_dirs == []
    assert cmd.json_stream is True
    assert cmd.ephemeral is True
