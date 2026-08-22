"""OpenCode path resolution and the generated per-process config."""

from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.builtin.agentic_process.cli_drivers.opencode.config_gen import (
    build_config,
    opencode_config_path_for_process,
    write_process_config,
)
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.session_history import (
    opencode_data_dir,
    opencode_db_path,
)
from flow_sdk.instance_settings import get_instance_settings


def test_test_instance_never_touches_the_developers_real_opencode_store():
    """The store must never resolve to the developer's own one.

    OpenCode publishes no ``OPENCODE_DATA_DIR``; it follows the XDG base dirs,
    and ``tests/conftest.py`` sandboxes ``$HOME`` before any flow_sdk import —
    so the guard that matters is against the PRE-sandbox home, stashed as
    ``FLOWPAD_PRE_SANDBOX_HOME``. A regression here would have a test run read,
    and a driver write, the real ``~/.local/share/opencode``.
    """
    import os

    data = opencode_data_dir()
    assert data == get_instance_settings().opencode_data_dir

    pre_sandbox_home = os.environ.get("FLOWPAD_PRE_SANDBOX_HOME")
    if pre_sandbox_home:
        real_local = Path(pre_sandbox_home) / ".local"
        assert not str(data).startswith(str(real_local)), f"opencode store is not sandboxed: {data}"

    # And it must sit under whichever root the resolver was told to use — which
    # is `$XDG_DATA_HOME` when that is set, and the sandboxed home only when it
    # is not. Asserting `Path.home()` unconditionally contradicts the resolver's
    # own contract (OpenCode follows the XDG base dirs, so honouring the var is
    # the whole design), and it fails wherever the environment legitimately sets
    # one: a CI runner does, a developer shell usually does not, so the test
    # passes locally and fails only on CI.
    xdg_data_home = os.environ.get("XDG_DATA_HOME")
    expected_root = Path(xdg_data_home) if xdg_data_home else Path.home()
    assert str(data).startswith(str(expected_root)), f"{data} is not under {expected_root}"


def test_db_path_sits_under_the_data_dir():
    assert opencode_db_path() == opencode_data_dir() / "opencode.db"


def test_config_carries_instructions_and_skills():
    config = build_config(
        instruction_files=["/assets/AGENTS.md"],
        skill_paths=["/assets/.opencode/skills"],
    )
    assert config["$schema"] == "https://opencode.ai/config.json"
    assert config["instructions"] == ["/assets/AGENTS.md"]
    assert config["skills"] == {"paths": ["/assets/.opencode/skills"]}


def test_config_omits_empty_sections():
    """opencode rejects unknown/invalid keys outright, so nothing empty is emitted."""
    config = build_config(instruction_files=["/assets/AGENTS.md"], skill_paths=[])
    assert "skills" not in config
    assert set(config) == {"$schema", "instructions"}


def test_config_never_contains_a_credential():
    """OpenRouter is a built-in provider resolved from the environment, so the
    generated config carries no provider block and no key — the file sits on
    disk in the shadow dir and must never be a secret at rest."""
    config = build_config(
        instruction_files=["/assets/AGENTS.md"], skill_paths=["/assets/.opencode/skills"]
    )
    blob = json.dumps(config)
    assert "provider" not in blob
    assert "apiKey" not in blob
    assert "sk-or-" not in blob


def test_write_process_config_returns_none_when_there_is_nothing_to_say():
    assert write_process_config("proc-empty", instruction_files=[], skill_paths=[]) is None


def test_write_process_config_round_trips(tmp_path, monkeypatch):
    process_id = "11111111-2222-4333-8444-555555555555"
    path = write_process_config(
        process_id,
        instruction_files=["/assets/AGENTS.md"],
        skill_paths=["/assets/.opencode/skills"],
    )
    assert path is not None
    assert path == opencode_config_path_for_process(process_id)
    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["instructions"] == ["/assets/AGENTS.md"]


# ---------------------------------------------------------------------------
# OPENCODE_CONFIG must always name a FILE
#
# ``custom_instruction_dirs[0]`` carries two shapes: the driver's own
# ``headless_prompt`` passes the generated ``opencode.json``, while the shared
# headless prompt path (``AgenticProcess._instruction_context_kwargs``) passes
# the raw instruction-assets DIRECTORY. Pointed at a directory, opencode dies
# on its first read with ``BadResource: FileSystem.readFile``, exit 1, before
# any model call — which killed every chat turn started from the UI while a
# bare createProcess + prompt (no assets, so an empty field) still worked.
# ---------------------------------------------------------------------------


def _context(dirs):
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgenticContext

    return AgenticContext(workdir="/tmp", custom_instruction_dirs=dirs)


def test_config_path_passes_through_a_generated_config_file(tmp_path):
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode.stream_worker import (
        _config_path_from_context,
    )

    generated = tmp_path / "opencode.json"
    generated.write_text("{}", encoding="utf-8")
    assert _config_path_from_context(_context([str(generated)]), "proc-1") == str(generated)


def test_config_path_generates_a_config_when_handed_the_assets_dir(tmp_path):
    """The shared prompt path's DIRECTORY must become a config file, not be
    forwarded verbatim into OPENCODE_CONFIG."""
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode.stream_worker import (
        _config_path_from_context,
    )

    assets = tmp_path / "execution" / "assets"
    (assets / ".opencode" / "skills").mkdir(parents=True)
    (assets / "AGENTS.md").write_text("be helpful", encoding="utf-8")

    process_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    resolved = _config_path_from_context(_context([str(assets)]), process_id)

    assert resolved is not None
    resolved_path = Path(resolved)
    assert resolved_path.is_file(), "OPENCODE_CONFIG must name a file, never a directory"
    assert resolved_path != assets
    body = json.loads(resolved_path.read_text(encoding="utf-8"))
    assert body["instructions"] == [str(assets / "AGENTS.md")]
    assert body["skills"] == {"paths": [str(assets / ".opencode" / "skills")]}


def test_config_path_omits_a_missing_agents_md(tmp_path):
    """``instructions`` entries are read eagerly too, so a listed-but-absent
    AGENTS.md would reintroduce the same fatal read."""
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode.stream_worker import (
        _config_path_from_context,
    )

    assets = tmp_path / "assets"
    assets.mkdir()
    # No AGENTS.md and no skills dir → nothing worth saying → no config at all.
    assert _config_path_from_context(_context([str(assets)]), "proc-2") is None


def test_config_path_is_none_without_a_process_id(tmp_path):
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode.stream_worker import (
        _config_path_from_context,
    )

    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "AGENTS.md").write_text("x", encoding="utf-8")
    assert _config_path_from_context(_context([str(assets)]), None) is None


# ---------------------------------------------------------------------------
# The PTY hole: nothing on the interactive spawn path ever set ``config_path``,
# so ``_sync_config_env`` was a silent no-op and an interactive opencode session
# received neither the process's instructions nor its skills. The shared
# instruction-assets application is now a method ON the argv class
# (``AgentOptions.apply_instruction_assets``), which opencode overrides — so
# both transports go through the one generator.
# ---------------------------------------------------------------------------


def _assets(tmp_path, process_id):
    import types

    from flow_sdk.builtin.agentic_process.cli_drivers.opencode.config_gen import SKILLS_SUBDIR

    assets = tmp_path / "assets"
    (assets / SKILLS_SUBDIR).mkdir(parents=True)
    (assets / "AGENTS.md").write_text("process instructions", encoding="utf-8")
    (assets / "CLAUDE.md").write_text("process instructions", encoding="utf-8")
    return types.SimpleNamespace(
        assets_dir=assets,
        instructions="process instructions",
        claude_file=assets / "CLAUDE.md",
        process_id=process_id,
    )


def test_instruction_assets_reach_an_interactive_spawn(tmp_path):
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode.cli import OpenCodeAgentOptions

    process_id = "11111111-2222-4333-8444-666666666666"
    cmd = OpenCodeAgentOptions(workdir="/tmp/proj", json_stream=False)
    cmd.apply_instruction_assets(_assets(tmp_path, process_id))

    assert cmd.config_path == str(opencode_config_path_for_process(process_id))
    _argv, env = cmd.to_spawn_args()
    assert env["OPENCODE_CONFIG"] == cmd.config_path
    written = json.loads(Path(cmd.config_path).read_text(encoding="utf-8"))
    assert written["instructions"] == [str(tmp_path / "assets" / "AGENTS.md")]
    assert written["skills"]["paths"]


def test_instruction_assets_never_emit_a_directory_flag(tmp_path):
    """OpenCode has no ``--add-dir``; the base's directory channels must not fire."""
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode.cli import OpenCodeAgentOptions

    cmd = OpenCodeAgentOptions(workdir="/tmp/proj", json_stream=False)
    cmd.apply_instruction_assets(_assets(tmp_path, "11111111-2222-4333-8444-777777777777"))
    argv, _env = cmd.to_spawn_args()
    assert "--add-dir" not in argv
    assert str(tmp_path / "assets") not in argv


def test_other_vendors_keep_the_directory_channel(tmp_path):
    """The seam moved; the default behaviour did not."""
    from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions

    assets = _assets(tmp_path, "irrelevant")
    cmd = ClaudeAgentOptions(workdir="/tmp/proj")
    cmd.apply_instruction_assets(assets)
    assert str(assets.assets_dir) in list(cmd.add_dirs or [])
    assert cmd.system_prompt_file == str(assets.claude_file)
