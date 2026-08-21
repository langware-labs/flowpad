from __future__ import annotations

import shlex

import pytest

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 compatibility
    import tomli as tomllib

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent_hook import HookEventType
from flow_sdk.builtin.agentic_process.asset_dir import AssetDir
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
)
from flow_sdk.builtin.agentic_process.cli_drivers.codex.cli import CodexAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.codex.driver import CodexDriver
from flow_sdk.builtin.agentic_process.cli_drivers.codex.stream_worker import (
    CodexCLIStreamWorker,
)
from tests.utils.fake_cli import make_fake_cli_bin, seed_harness_capability


def _config_flags(argv: list[str]) -> list[str]:
    return [argv[index + 1] for index, value in enumerate(argv[:-1]) if value == "-c"]


def test_codex_process_hook_runtime_is_structured_fileless_and_deterministic(
    tmp_path,
    monkeypatch,
):
    process_id = str(mint_uuid())
    assets = AssetDir(tmp_path / "missing-assets")
    command = "/opt/Flow Pad/flow's «cli»\n🧪"
    prefix = ["--launcher", 'C:\\Flow Pad\\flow "entry".py', "O'Brien"]
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.codex.driver.get_installed_flow_invocation",
        lambda: (command, prefix),
    )

    driver = CodexDriver()
    runtime = driver.prepare_process_hooks(
        assets,
        process_id,
        [HookEventType.USER_PROMPT_SUBMIT],
    )
    flow_argv = [
        command,
        *prefix,
        "hooks",
        "report",
        "--process-id",
        process_id,
    ]
    handler = runtime.config_overrides[1][1][0]["hooks"][0]

    assert runtime.plugin_dirs == ()
    assert runtime.bypass_hook_trust is True
    assert runtime.config_overrides[0] == ("features.hooks", True)
    assert handler["type"] == "command"
    assert shlex.split(handler["command"]) == flow_argv
    assert handler["commandWindows"] == " ".join(
        [
            "'/opt/Flow Pad/flow''s «cli»\n🧪'",
            "--launcher",
            "'C:\\Flow Pad\\flow \"entry\".py'",
            "'O''Brien'",
            "hooks",
            "report",
            "--process-id",
            process_id,
        ]
    )
    assert not assets.os_path.exists()

    # Reconciliation, semantic snapshots, and removal are all pure: Codex has
    # no process plugin or config projection on disk.
    assert driver.prepare_process_hooks(assets, process_id, []) == type(runtime)()
    assert driver.process_hook_snapshot([]) == {}
    assert driver.process_hook_snapshot([HookEventType.USER_PROMPT_SUBMIT]) == {
        "events": ["UserPromptSubmit"],
        "provider": "codex",
        "schema": 2,
    }
    assert not assets.os_path.exists()


def test_codex_structured_hook_overrides_are_one_toml_argv_slot_each(
    tmp_path,
    monkeypatch,
):
    process_id = str(mint_uuid())
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.codex.driver.get_installed_flow_invocation",
        lambda: ("/opt/Flow Pad/flow\n🧪", ['C:\\Program Files\\Flow "entry".py']),
    )
    runtime = CodexDriver().prepare_process_hooks(
        AssetDir(tmp_path / "assets"),
        process_id,
        [HookEventType.USER_PROMPT_SUBMIT],
    )
    options = CodexAgentOptions(workdir=str(tmp_path))
    options.extra_config_overrides = list(runtime.config_overrides)
    options.bypass_hook_trust = runtime.bypass_hook_trust

    argv, _ = options.to_spawn_args()
    config_flags = _config_flags(argv)
    features = next(value for value in config_flags if value.startswith("features.hooks="))
    hooks = next(value for value in config_flags if value.startswith("hooks.UserPromptSubmit="))

    assert tomllib.loads(features) == {"features": {"hooks": True}}
    parsed_hooks = tomllib.loads(hooks)
    handler = parsed_hooks["hooks"]["UserPromptSubmit"][0]["hooks"][0]
    assert handler["type"] == "command"
    assert handler["command"].endswith(f"--process-id {process_id}")
    assert handler["commandWindows"].endswith(f"--process-id {process_id}")
    assert argv.count("--dangerously-bypass-hook-trust") == 1
    assert not (tmp_path / "assets").exists()


def test_codex_stream_worker_copies_hook_runtime_from_context(tmp_path, monkeypatch):
    bin_dir, codex = make_fake_cli_bin(tmp_path, "codex")
    seed_harness_capability(monkeypatch, "codex", bin_dir)
    overrides = [
        ("features.hooks", True),
        ("hooks.UserPromptSubmit", [{"hooks": [{"type": "command", "command": "handler"}]}]),
    ]
    context = AgenticContext(
        workdir=str(tmp_path),
        extra_config_overrides=overrides,
        bypass_hook_trust=True,
    )

    argv, _env, stdin = CodexCLIStreamWorker()._build_spawn(context, "hello")

    assert argv[0] == str(codex)
    assert argv.count("--dangerously-bypass-hook-trust") == 1
    config_flags = _config_flags(argv)
    assert tomllib.loads(next(v for v in config_flags if v.startswith("features.hooks="))) == {
        "features": {"hooks": True}
    }
    assert (
        tomllib.loads(next(v for v in config_flags if v.startswith("hooks.UserPromptSubmit=")))["hooks"][
            "UserPromptSubmit"
        ][0]["hooks"][0]["command"]
        == "handler"
    )
    assert stdin == "hello"


def test_codex_hook_runtime_fields_are_not_persisted():
    overrides = [
        ("features.hooks", True),
        ("hooks.UserPromptSubmit", [{"hooks": [{"type": "command", "command": "handler"}]}]),
    ]
    options = CodexAgentOptions(bypass_hook_trust=True)
    options.extra_config_overrides = overrides
    context = AgenticContext(
        extra_config_overrides=overrides,
        bypass_hook_trust=True,
    )

    assert "extra_config_overrides" not in options.to_json()
    assert "bypass_hook_trust" not in options.to_json()
    assert "extra_config_overrides" not in context.to_persistable_dict()
    assert "bypass_hook_trust" not in context.to_persistable_dict()
    assert (
        CodexAgentOptions.from_json(
            {
                "extra_config_overrides": overrides,
                "bypass_hook_trust": True,
            }
        ).bypass_hook_trust
        is False
    )


def test_codex_hook_normalization_is_sparse_and_preserves_native_payload():
    driver = CodexDriver()
    process_id = str(mint_uuid())
    raw = {
        "hook_event_name": "UserPromptSubmit",
        "prompt": "line one\nline two 🧪",
        "session_id": "session",
        "cwd": "/repo",
        "transcript_path": "/tmp/session.jsonl",
        "turn_id": "turn-1",
        "permission_mode": "never",
        "model": "gpt-5.5",
        "unknown": {"nested": [1, 2]},
    }

    data = driver.normalize_process_hook_data(process_id, raw)

    assert data.agentic_process_id == process_id
    assert data.hook_data == {
        **{key: value for key, value in raw.items() if key != "unknown"},
        "raw_hook_data": raw,
    }
    sparse_raw = {"hook_event_name": "UserPromptSubmit", "prompt": ""}
    sparse = driver.normalize_process_hook_data(process_id, sparse_raw)
    assert sparse.hook_data == {
        "hook_event_name": "UserPromptSubmit",
        "prompt": "",
        "raw_hook_data": sparse_raw,
    }


@pytest.mark.parametrize(
    ("process_id", "raw", "match"),
    [
        ("not-a-process-id", {"hook_event_name": "UserPromptSubmit"}, "Invalid agentic process id"),
        (str(mint_uuid()), {}, "Unsupported Codex process hook event"),
        (str(mint_uuid()), {"hook_event_name": "Stop"}, "Unsupported Codex process hook event"),
    ],
)
def test_codex_hook_normalization_rejects_invalid_target_or_event(process_id, raw, match):
    with pytest.raises(ValueError, match=match):
        CodexDriver().normalize_process_hook_data(process_id, raw)


def test_codex_hook_prepare_rejects_before_filesystem_writes(tmp_path):
    assets = AssetDir(tmp_path / "missing-assets")
    driver = CodexDriver()

    with pytest.raises(ValueError, match="Invalid agentic process id"):
        driver.prepare_process_hooks(
            assets,
            "not-a-process-id",
            [HookEventType.USER_PROMPT_SUBMIT],
        )
    with pytest.raises(ValueError, match="Unsupported Codex process hook event"):
        driver.prepare_process_hooks(
            assets,
            str(mint_uuid()),
            [HookEventType.STOP],
        )

    assert not assets.os_path.exists()


def test_codex_projects_one_config_override_slot_per_configured_event(tmp_path, monkeypatch):
    """``hooks`` is a TOML table keyed by event — one ``-c`` slot each."""
    process_id = str(mint_uuid())
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.codex.driver.get_installed_flow_invocation",
        lambda: ("/opt/flow", []),
    )
    runtime = CodexDriver().prepare_process_hooks(
        AssetDir(tmp_path / "assets"),
        process_id,
        [HookEventType.SESSION_START, HookEventType.SESSION_END, HookEventType.USER_PROMPT_SUBMIT],
    )
    options = CodexAgentOptions(workdir=str(tmp_path))
    options.extra_config_overrides = list(runtime.config_overrides)
    options.bypass_hook_trust = runtime.bypass_hook_trust

    argv, _ = options.to_spawn_args()
    config_flags = _config_flags(argv)

    keys = [key for key, _ in runtime.config_overrides]
    assert keys == ["features.hooks", "hooks.SessionEnd", "hooks.SessionStart", "hooks.UserPromptSubmit"]
    for event in ("SessionEnd", "SessionStart", "UserPromptSubmit"):
        rendered = next(value for value in config_flags if value.startswith(f"hooks.{event}="))
        handler = tomllib.loads(rendered)["hooks"][event][0]["hooks"][0]
        assert handler["type"] == "command"
        assert handler["command"].endswith(f"--process-id {process_id}")
        assert handler["commandWindows"].endswith(f"--process-id {process_id}")
    assert argv.count("--dangerously-bypass-hook-trust") == 1
    assert not (tmp_path / "assets").exists()

    # Codex stays fileless for every event combination.
    assert CodexDriver().prepare_process_hooks(AssetDir(tmp_path / "assets"), process_id, []).config_overrides == ()


def test_codex_session_snapshot_and_normalization_carry_lifecycle_fields():
    driver = CodexDriver()
    process_id = str(mint_uuid())

    assert driver.process_hook_snapshot([HookEventType.SESSION_START, HookEventType.SESSION_END]) == {
        "events": ["SessionEnd", "SessionStart"],
        "provider": "codex",
        "schema": 2,
    }

    start_raw = {
        "hook_event_name": "SessionStart",
        "source": "startup",
        "session_id": "rollout-1",
        "cwd": "/repo",
        "transcript_path": "/tmp/rollout.jsonl",
        "permission_mode": "never",
        "model": "gpt-5.5",
    }
    start = driver.normalize_process_hook_data(process_id, start_raw)
    assert start.hook_data == {**start_raw, "raw_hook_data": start_raw}

    # Codex currently always reports reason="other"; the value is passed
    # through, never validated against a vocabulary.
    end_raw = {
        "hook_event_name": "SessionEnd",
        "reason": "other",
        "session_id": "rollout-1",
        "cwd": "/repo",
        "transcript_path": "/tmp/rollout.jsonl",
    }
    end = driver.normalize_process_hook_data(process_id, end_raw)
    assert end.hook_data == {**end_raw, "raw_hook_data": end_raw}
