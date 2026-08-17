from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent_hook import HookEventType
from flow_sdk.builtin.agentic_process.asset_dir import AssetDir
from flow_sdk.builtin.agentic_process.cli_drivers.copilot import driver as driver_module
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.driver import CopilotDriver


def test_process_hook_plugin_projection_is_deterministic_and_reconciles_stale_files(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process_id = str(mint_uuid())
    command = "/opt/Flow Pad/flow's \U0001f600"
    prefix = ["--shim", "C:\\Flow Pad\\line one\r\nline two"]
    monkeypatch.setattr(
        driver_module,
        "get_installed_flow_invocation",
        lambda: (command, prefix),
    )
    assets = AssetDir(tmp_path / "process assets")
    plugin = assets.os_path / ".flowpad/plugins/copilot/flowpad-process-hooks"
    stale = plugin / "stale.json"
    stale.parent.mkdir(parents=True)
    stale.write_text("stale", encoding="utf-8")

    runtime = CopilotDriver().prepare_process_hooks(
        assets,
        process_id,
        [HookEventType.USER_PROMPT_SUBMIT],
    )

    assert runtime.plugin_dirs == (str(plugin),)
    assert sorted(path.relative_to(plugin).as_posix() for path in plugin.rglob("*") if path.is_file()) == [
        "hooks.json",
        "plugin.json",
    ]
    assert json.loads((plugin / "plugin.json").read_text(encoding="utf-8")) == {
        "author": {"name": "Flowpad"},
        "description": "Flowpad process-scoped hooks",
        "hooks": "hooks.json",
        "name": "flowpad-process-hooks",
        "version": "1.0.0",
    }
    assert json.loads((plugin / "hooks.json").read_text(encoding="utf-8")) == {
        "hooks": {
            "userPromptSubmitted": [
                {
                    "type": "command",
                    "bash": (
                        "'/opt/Flow Pad/flow'\"'\"'s \U0001f600' --shim "
                        "'C:\\Flow Pad\\line one\r\nline two' hooks report "
                        f"--process-id {process_id}"
                    ),
                    "powershell": (
                        "'/opt/Flow Pad/flow''s \U0001f600' --shim "
                        "'C:\\Flow Pad\\line one\r\nline two' hooks report "
                        f"--process-id {process_id}"
                    ),
                }
            ]
        },
        "version": 1,
    }
    first = {path.name: path.read_bytes() for path in plugin.iterdir()}
    CopilotDriver().prepare_process_hooks(
        assets,
        process_id,
        [HookEventType.USER_PROMPT_SUBMIT],
    )
    assert {path.name: path.read_bytes() for path in plugin.iterdir()} == first
    assert (plugin / "plugin.json").read_bytes().endswith(b"\n")
    assert (plugin / "hooks.json").read_bytes().endswith(b"\n")


def test_empty_hook_reconciliation_removes_only_copilot_subtree(tmp_path: Path) -> None:
    process_id = str(mint_uuid())
    assets = AssetDir(tmp_path / "assets")
    plugin = assets.os_path / ".flowpad/plugins/copilot/flowpad-process-hooks"
    sibling = assets.os_path / ".flowpad/plugins/claude/keep.txt"
    plugin.mkdir(parents=True)
    (plugin / "stale").write_text("stale", encoding="utf-8")
    sibling.parent.mkdir(parents=True)
    sibling.write_text("keep", encoding="utf-8")

    runtime = CopilotDriver().prepare_process_hooks(assets, process_id, [])

    assert runtime.plugin_dirs == ()
    assert not plugin.exists()
    assert sibling.read_text(encoding="utf-8") == "keep"

    missing_assets = AssetDir(tmp_path / "missing-assets")
    CopilotDriver().prepare_process_hooks(missing_assets, process_id, [])
    assert not missing_assets.os_path.exists()


@pytest.mark.parametrize(
    "events,process_id",
    [
        ([HookEventType.PRE_TOOL_USE], str(mint_uuid())),
        ([HookEventType.USER_PROMPT_SUBMIT], "not-a-process-id"),
        ([], "not-a-process-id"),
    ],
)
def test_invalid_hook_inputs_fail_before_filesystem_mutation(
    tmp_path: Path,
    events: list[HookEventType],
    process_id: str,
) -> None:
    assets = AssetDir(tmp_path / "missing-assets")

    with pytest.raises(ValueError):
        CopilotDriver().prepare_process_hooks(assets, process_id, events)

    assert not assets.os_path.exists()


def test_process_hook_snapshot_is_semantic_and_does_not_materialize_assets(tmp_path: Path) -> None:
    driver = CopilotDriver()
    assets_path = tmp_path / "assets"

    assert driver.process_hook_snapshot([]) == {}
    assert driver.process_hook_snapshot([HookEventType.USER_PROMPT_SUBMIT]) == {
        "events": ["UserPromptSubmit"],
        "provider": "copilot",
        "schema": 1,
    }
    assert not assets_path.exists()


def test_native_and_vscode_payloads_normalize_to_canonical_agent_hook_data() -> None:
    driver = CopilotDriver()
    process_id = str(mint_uuid())
    native = {
        "sessionId": "native-session",
        "timestamp": 1786406400,
        "cwd": "/repo",
        "prompt": "line one\nline two \U0001f600\n",
        "nativeOnly": {"kept": True},
    }
    vscode = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "vscode-session",
        "timestamp": "2026-08-11T12:00:00.000Z",
        "cwd": "C:\\repo",
        "prompt": "hello",
        "vscode_only": 7,
    }

    native_data = driver.normalize_process_hook_data(process_id, native)
    vscode_data = driver.normalize_process_hook_data(process_id, vscode)

    assert native_data.agentic_process_id == process_id
    assert native_data.hook_data == {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "native-session",
        "timestamp": 1786406400,
        "cwd": "/repo",
        "prompt": "line one\nline two \U0001f600",
        "raw_hook_data": native,
    }
    assert vscode_data.hook_data == {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "vscode-session",
        "timestamp": "2026-08-11T12:00:00.000Z",
        "cwd": "C:\\repo",
        "prompt": "hello",
        "raw_hook_data": vscode,
    }

    sparse = driver.normalize_process_hook_data(process_id, {"prompt": ""})
    assert sparse.hook_data == {
        "hook_event_name": "UserPromptSubmit",
        "prompt": "",
        "raw_hook_data": {"prompt": ""},
    }


def test_normalization_rejects_invalid_target_and_wrong_supplied_event() -> None:
    driver = CopilotDriver()

    with pytest.raises(ValueError):
        driver.normalize_process_hook_data("not-a-process-id", {"prompt": "hello"})
    with pytest.raises(ValueError):
        driver.normalize_process_hook_data(
            str(mint_uuid()),
            {"hook_event_name": "PreToolUse", "prompt": "hello"},
        )
