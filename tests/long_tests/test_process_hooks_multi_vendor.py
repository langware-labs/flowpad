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
    report_seen = asyncio.Event()

    def callback(data):
        reports.append(data)
        report_seen.set()

    def noop_unsubscribe():
        return None

    unsubscribe = noop_unsubscribe
    hook_configured = False
    try:
        assert await process.set_hook(HookEventType.USER_PROMPT_SUBMIT) is True
        hook_configured = True
        unsubscribe = process.register_callback(callback)

        rehydrated = await AgenticProcess.get_by_id(process.id)
        assert rehydrated is not None
        assert rehydrated.process_hook_events == [_CONTRACT["expected_persisted_event"]]

        async with _serve_process_hook_route(settings.server_json_path):
            result = await process.prompt(_CONTRACT["prompt"])
            assert result.status == "SUCCESS", result
            await report_seen.wait()

        assert len(reports) == 1
        report = reports[0]
        assert report.agentic_process_id == process.id
        assert report.hook_data["hook_event_name"] == _CONTRACT["event"]
        assert report.hook_data["prompt"] == _CONTRACT["expected_callback_prompt"]
        assert report.hook_data["session_id"]
        vendor = _CONTRACT["vendors"][worker_type]
        assert report.hook_data["raw_hook_data"]["prompt"] == (_CONTRACT["prompt"] + vendor["raw_prompt_suffix"])

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
        if hook_configured:
            assert await process.remove_hook(HookEventType.USER_PROMPT_SUBMIT) is True
        unsubscribe()
        unsubscribe()
        await process.delete()
        reset_instance_settings()


_SESSION_VENDORS = [
    pytest.param("claude_code", "claude", "harness.claude.cli", id="claude"),
    *_VENDORS,
]


@pytest.mark.asyncio
@pytest.mark.parametrize(("worker_type", "binary", "capability_kind"), _SESSION_VENDORS)
async def test_session_hooks_deliver_from_a_real_vendor(
    initialize_test_db,
    monkeypatch,
    tmp_path,
    worker_type,
    binary,
    capability_kind,
):
    """A live turn delivers SessionStart alongside the prompt hook.

    Assertions are on per-event presence and ordering, never on counts:
    Claude fires SessionStart on startup/resume/clear/compact, and Copilot
    fires sessionEnd per agentic loop by default — both vendors legitimately
    emit lifecycle hooks more than once per process.
    """
    if shutil.which(binary) is None:
        pytest.skip(f"{binary} command not found in PATH")

    from flow_sdk.builtin.agent_hook import HookEventType
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.core.capabilities.discovery import run_discovery
    from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings

    monkeypatch.setenv("FLOW_HOME", str(tmp_path / "flow-home"))
    monkeypatch.setenv("FLOW_INSTANCE", f"session-hook-{worker_type}")
    monkeypatch.setenv("LOCAL_SERVER_PORT", "0")
    monkeypatch.setenv("FLOWPAD_SKIP_LOCK", "true")
    reset_instance_settings()
    settings = get_instance_settings()
    await run_discovery([capability_kind])

    cli_config = {"permission_mode": "bypassPermissions"}
    if worker_type != "copilot":
        cli_config["model"] = "sm"
    if worker_type == "claude_code":
        cli_config["effort"] = "low"
    process = await AgenticProcess(
        worker_type=worker_type,
        workdir=str(tmp_path),
        visible=False,
        pty_mode=False,
        load_flowpad_assistant=False,
        cli_config=cli_config,
    ).save()

    events = (
        HookEventType.SESSION_START,
        HookEventType.SESSION_END,
        HookEventType.USER_PROMPT_SUBMIT,
    )
    reports = []
    # SessionEnd is deliberately NOT awaited: Claude defers it to real session
    # teardown while Copilot fires it per agentic loop.
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
        for event in events:
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

        delivered = [report.hook_data.get("hook_event_name") for report in reports]
        assert HookEventType.SESSION_START.value in delivered, delivered
        assert HookEventType.USER_PROMPT_SUBMIT.value in delivered, delivered
        # Relative ORDER is deliberately not asserted: claude and codex open
        # the session before submitting the prompt, while copilot emits
        # userPromptSubmitted first and sessionStart after. Both are the
        # vendors' own sequencing, not part of our contract.

        for report in reports:
            assert report.agentic_process_id == process.id
            assert report.hook_data["session_id"]
            event_name = report.hook_data["hook_event_name"]
            assert event_name in _CONTRACT["expected_persisted_session_events"]
            expectation = _CONTRACT["session_events"].get(event_name)
            if expectation:
                # Vendor vocabularies differ (claude "startup" vs copilot
                # "new"), so only presence of the discriminator is pinned.
                assert report.hook_data[expectation["discriminator"]]
                assert "prompt" not in report.hook_data
    finally:
        for event in configured:
            await process.remove_hook(event)
        unsubscribe()
        await process.delete()
        reset_instance_settings()
