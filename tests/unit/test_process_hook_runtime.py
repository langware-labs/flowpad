from __future__ import annotations

import json

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent_hook import HookEventType
from flow_sdk.builtin.agentic_process.asset_dir import AssetDir
from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli_worker import ClaudeCLIWorker
from flow_sdk.builtin.agentic_process.cli_drivers.claude.code_agentic_worker import _local_plugin_configs
from flow_sdk.builtin.agentic_process.cli_drivers.claude.driver import ClaudeDriver
from flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker import ClaudeCLIStreamWorker
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    ProcessHookRuntime,
)
from flow_sdk.builtin.flowpad_runner_wrapper import (
    get_installed_flow_invocation,
    get_wrapper_path,
)
from flow_sdk.instance_settings import reset_instance_settings


@pytest.fixture()
def isolated_wrapper(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(tmp_path / "sandbox with space"))
    reset_instance_settings()
    yield
    reset_instance_settings()


def test_claude_process_hook_projection_is_deterministic(tmp_path, isolated_wrapper):
    process_id = str(mint_uuid())
    assets = AssetDir(tmp_path / "assets")
    driver = ClaudeDriver()

    runtime = driver.prepare_process_hooks(
        assets,
        process_id,
        [HookEventType.USER_PROMPT_SUBMIT],
    )
    plugin = assets.os_path / ".flowpad/plugins/claude/flowpad-process-hooks"
    first = {path.relative_to(plugin): path.read_bytes() for path in plugin.rglob("*.json")}
    assert runtime.plugin_dirs == (str(plugin),)

    assert json.loads(first[next(path for path in first if path.name == "plugin.json")]) == {
        "author": {"name": "Flowpad"},
        "description": "Flowpad process-scoped hooks",
        "name": "flowpad-process-hooks",
        "version": "1.0.0",
    }
    hook = json.loads(first[next(path for path in first if path.name == "hooks.json")])["hooks"]["UserPromptSubmit"][0][
        "hooks"
    ][0]
    command, prefix = get_installed_flow_invocation()
    assert hook == {
        "args": [*prefix, "hooks", "report", "--process-id", process_id],
        "command": command,
        "type": "command",
    }
    assert not get_wrapper_path().exists()
    driver.prepare_process_hooks(
        assets,
        process_id,
        [HookEventType.USER_PROMPT_SUBMIT],
    )
    assert {path.relative_to(plugin): path.read_bytes() for path in plugin.rglob("*.json")} == first


def test_claude_hook_removal_reconciles_only_its_reserved_projection(tmp_path, isolated_wrapper):
    process_id = str(mint_uuid())
    assets = AssetDir(tmp_path / "assets")
    claude = ClaudeDriver()
    claude.prepare_process_hooks(
        assets,
        process_id,
        [HookEventType.USER_PROMPT_SUBMIT],
    )
    plugin = assets.os_path / ".flowpad/plugins/claude/flowpad-process-hooks"

    assert claude.prepare_process_hooks(assets, process_id, []).plugin_dirs == ()
    assert not plugin.exists()


def test_empty_claude_hook_reconciliation_does_not_create_asset_root(tmp_path):
    assets = AssetDir(tmp_path / "missing-assets")

    runtime = ClaudeDriver().prepare_process_hooks(assets, str(mint_uuid()), [])

    assert runtime.plugin_dirs == ()
    assert not assets.os_path.exists()


def test_claude_hook_snapshot_and_native_normalization_are_semantic():
    driver = ClaudeDriver()
    process_id = str(mint_uuid())
    raw = {
        "hook_event_name": "UserPromptSubmit",
        "prompt": "line one\nline two",
        "session_id": "session",
        "cwd": "/repo",
        "transcript_path": "/tmp/session.jsonl",
        "permission_mode": "plan",
    }

    assert driver.process_hook_snapshot([]) == {}
    assert driver.process_hook_snapshot([HookEventType.USER_PROMPT_SUBMIT]) == {
        "events": ["UserPromptSubmit"],
        "provider": "claude",
        "schema": 2,
    }
    data = driver.normalize_process_hook_data(process_id, raw)
    assert data.agentic_process_id == process_id
    assert data.hook_data == {
        **{
            key: raw[key]
            for key in (
                "hook_event_name",
                "prompt",
                "session_id",
                "cwd",
                "transcript_path",
            )
        },
        "raw_hook_data": raw,
    }

    sparse = driver.normalize_process_hook_data(
        process_id,
        {"hook_event_name": "UserPromptSubmit", "prompt": ""},
    )
    assert sparse.hook_data == {
        "hook_event_name": "UserPromptSubmit",
        "prompt": "",
        "raw_hook_data": {"hook_event_name": "UserPromptSubmit", "prompt": ""},
    }


def test_plugin_dirs_propagate_through_every_claude_context_consumer():
    plugin_dirs = ["/plugins/one", "/plugins/two with space"]
    context = AgenticContext(workdir="/repo", plugin_dirs=plugin_dirs)

    options = ClaudeAgentOptions(plugin_dirs=plugin_dirs)
    stream_options = ClaudeCLIStreamWorker._options_from_context(context)
    cli_args = ClaudeCLIWorker.build_args("claude", "hi", "session", context)

    assert _flag_values(options.cli_cmd(), "--plugin-dir") == plugin_dirs
    assert _flag_values(stream_options.cli_cmd(), "--plugin-dir") == plugin_dirs
    assert _flag_values(cli_args, "--plugin-dir") == plugin_dirs
    assert _local_plugin_configs(context.plugin_dirs) == [{"type": "local", "path": path} for path in plugin_dirs]
    assert "plugin_dirs" not in options.to_json()
    assert ClaudeAgentOptions.from_json({"plugin_dirs": ["/persisted"]}).plugin_dirs == []
    assert "plugin_dirs" not in context.to_persistable_dict()


def test_process_hook_runtime_fields_are_launch_only() -> None:
    runtime = ProcessHookRuntime(
        plugin_dirs=("/runtime/plugin",),
        config_overrides=(("features.hooks", True),),
        bypass_hook_trust=True,
    )
    context = AgenticContext(
        workdir="/repo",
        plugin_dirs=list(runtime.plugin_dirs),
        extra_config_overrides=list(runtime.config_overrides),
        bypass_hook_trust=runtime.bypass_hook_trust,
    )

    persisted = context.to_persistable_dict()
    assert "plugin_dirs" not in persisted
    assert "extra_config_overrides" not in persisted
    assert "bypass_hook_trust" not in persisted


def _flag_values(argv: list[str], flag: str) -> list[str]:
    return [argv[index + 1] for index, value in enumerate(argv[:-1]) if value == flag]


def test_claude_projection_emits_one_handler_per_configured_event(tmp_path, isolated_wrapper):
    process_id = str(mint_uuid())
    assets = AssetDir(tmp_path / "assets")
    driver = ClaudeDriver()

    driver.prepare_process_hooks(
        assets,
        process_id,
        [HookEventType.SESSION_START, HookEventType.SESSION_END, HookEventType.USER_PROMPT_SUBMIT],
    )
    plugin = assets.os_path / ".flowpad/plugins/claude/flowpad-process-hooks"
    hooks = json.loads((plugin / "hooks/hooks.json").read_text(encoding="utf-8"))["hooks"]

    command, prefix = get_installed_flow_invocation()
    expected = {
        "args": [*prefix, "hooks", "report", "--process-id", process_id],
        "command": command,
        "type": "command",
    }
    assert sorted(hooks) == ["SessionEnd", "SessionStart", "UserPromptSubmit"]
    for event, entries in hooks.items():
        # Matcher-free: SessionStart/SessionEnd matchers select on
        # source/reason, and omitting one means "every occurrence".
        assert entries == [{"hooks": [expected]}], event


def test_claude_removing_one_event_keeps_the_others_projected(tmp_path, isolated_wrapper):
    process_id = str(mint_uuid())
    assets = AssetDir(tmp_path / "assets")
    driver = ClaudeDriver()
    plugin = assets.os_path / ".flowpad/plugins/claude/flowpad-process-hooks"

    driver.prepare_process_hooks(assets, process_id, [HookEventType.SESSION_START, HookEventType.SESSION_END])
    driver.prepare_process_hooks(assets, process_id, [HookEventType.SESSION_END])

    assert sorted(json.loads((plugin / "hooks/hooks.json").read_text(encoding="utf-8"))["hooks"]) == ["SessionEnd"]
    assert driver.prepare_process_hooks(assets, process_id, []).plugin_dirs == ()
    assert not plugin.exists()


def test_claude_session_snapshot_and_normalization_carry_lifecycle_fields():
    driver = ClaudeDriver()
    process_id = str(mint_uuid())

    assert driver.process_hook_snapshot([HookEventType.SESSION_END, HookEventType.SESSION_START]) == {
        "events": ["SessionEnd", "SessionStart"],
        "provider": "claude",
        "schema": 2,
    }

    start_raw = {
        "hook_event_name": "SessionStart",
        "source": "resume",
        "session_id": "session",
        "transcript_path": "/tmp/session.jsonl",
        "permission_mode": "plan",
        "model": "sonnet",
    }
    start = driver.normalize_process_hook_data(process_id, start_raw)
    assert start.hook_data == {
        "hook_event_name": "SessionStart",
        "session_id": "session",
        "transcript_path": "/tmp/session.jsonl",
        "source": "resume",
        "raw_hook_data": start_raw,
    }

    end_raw = {
        "hook_event_name": "SessionEnd",
        "reason": "prompt_input_exit",
        "session_id": "session",
        "cwd": "/repo",
        "transcript_path": "/tmp/session.jsonl",
    }
    end = driver.normalize_process_hook_data(process_id, end_raw)
    assert end.hook_data == {
        "hook_event_name": "SessionEnd",
        "session_id": "session",
        "cwd": "/repo",
        "transcript_path": "/tmp/session.jsonl",
        "reason": "prompt_input_exit",
        "raw_hook_data": end_raw,
    }
