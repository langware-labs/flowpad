"""Real Codex and Copilot process-hook acceptance.

Each case uses the installed vendor binary, the generated launch contribution,
the real ``flow hooks report`` route, and the public AgenticProcess callback API.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import sys
from pathlib import Path

import pytest

from tests.long_tests.test_claude_cli import _serve_process_hook_route
from tests.test_settings import test_service_config

_CONTRACT = json.loads(
    (Path(__file__).parents[1] / "fixtures" / "process_hook_acceptance.json").read_text(encoding="utf-8")
)

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

_VENDORS = [
    pytest.param("codex", "codex", "harness.codex.cli", id="codex"),
    pytest.param("copilot", "copilot", "harness.copilot.cli", id="copilot"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(("worker_type", "binary", "capability_kind"), _VENDORS)
async def test_process_hook_acceptance_uses_real_vendor(
    initialize_test_db,
    monkeypatch,
    tmp_path,
    worker_type,
    binary,
    capability_kind,
):
    if shutil.which(binary) is None:
        pytest.skip(f"{binary} command not found in PATH")

    from flow_sdk.builtin.agent_hook import HookEventType
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.core.capabilities.discovery import run_discovery
    from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings

    monkeypatch.setenv("FLOW_HOME", str(tmp_path / "flow-home"))
    monkeypatch.setenv("FLOW_INSTANCE", f"process-hook-{worker_type}")
    monkeypatch.setenv("LOCAL_SERVER_PORT", "0")
    monkeypatch.setenv("FLOWPAD_SKIP_LOCK", "true")
    reset_instance_settings()
    settings = get_instance_settings()
    await run_discovery([capability_kind])

    cli_config = {"permission_mode": "bypassPermissions"}
    if worker_type == "codex":
        cli_config["model"] = "sm"
    process = await AgenticProcess(
        worker_type=worker_type,
        workdir=str(tmp_path),
        visible=False,
        pty_mode=False,
        load_flowpad_assistant=False,
        cli_config=cli_config,
    ).save()

    reports = []
    # SessionEnd is deliberately not awaited: claude defers it to real session
    # teardown while copilot fires it per agentic loop. Relative order is not
    # asserted either — copilot emits the prompt hook before sessionStart.
    awaited = (HookEventType.SESSION_START, HookEventType.USER_PROMPT_SUBMIT)
    seen = {event.value: asyncio.Event() for event in awaited}

    def callback(data):
        reports.append(data)
        arrived = seen.get(data.hook_data.get("hook_event_name"))
        if arrived is not None:
            arrived.set()

    def noop_unsubscribe():
        return None

    unsubscribe = noop_unsubscribe
    configured = []
    try:
        for event in (HookEventType.SESSION_START, HookEventType.SESSION_END, HookEventType.USER_PROMPT_SUBMIT):
            assert await process.set_hook(event) is True
            configured.append(event)
        unsubscribe = process.register_callback(callback)

        rehydrated = await AgenticProcess.get_by_id(process.id)
        assert rehydrated is not None
        assert rehydrated.process_hook_events == _CONTRACT["expected_persisted_session_events"]

        async with _serve_process_hook_route(settings.server_json_path):
            result = await process.prompt(_CONTRACT["prompt"])
            assert result.status == "SUCCESS", result
            await asyncio.gather(*(arrived.wait() for arrived in seen.values()))

        vendor = _CONTRACT["vendors"][worker_type]
        by_event = {report.hook_data["hook_event_name"]: report for report in reports}
        assert set(by_event) >= {event.value for event in awaited}, list(by_event)

        report = by_event[_CONTRACT["event"]]
        assert report.agentic_process_id == process.id
        assert report.hook_data["prompt"] == _CONTRACT["expected_callback_prompt"]
        assert report.hook_data["raw_hook_data"]["prompt"] == (_CONTRACT["prompt"] + vendor["raw_prompt_suffix"])

        for event_name, report in by_event.items():
            assert report.agentic_process_id == process.id
            assert report.hook_data["session_id"]
            discriminator = _CONTRACT["session_discriminators"].get(event_name)
            if discriminator:
                # Vocabularies differ per vendor, so only presence is pinned.
                assert report.hook_data[discriminator]
                assert "prompt" not in report.hook_data

        if worker_type == "copilot":
            plugin = process._process_assets_path() / vendor["plugin_relative_path"]
            assert all((plugin / relative).is_file() for relative in vendor["plugin_files"])
            hooks = json.loads((plugin / "hooks.json").read_text(encoding="utf-8"))
            handler = hooks["hooks"][vendor["config_event"]][0]
            selected_command = handler["powershell" if sys.platform == "win32" else "bash"]
            assert f"--process-id {process.id}" in selected_command
        else:
            assert not (process._process_assets_path() / ".flowpad/plugins/codex").exists()
            assert not process._process_assets_path().exists()
    finally:
        for event in configured:
            await process.remove_hook(event)
        unsubscribe()
        unsubscribe()
        await process.delete()
        reset_instance_settings()
