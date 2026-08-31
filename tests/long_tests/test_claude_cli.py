"""Long test: Claude Code CLI invocation (requires Claude installed + valid auth)."""

import asyncio
import json
import os
import socket
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path

import pytest

from tests.test_settings import test_service_config
from tests.utils import find_claude, run_claude

_HOOK_CONTRACT = json.loads(
    (Path(__file__).parents[1] / "fixtures" / "process_hook_acceptance.json").read_text(encoding="utf-8")
)

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)


def test_claude_cli():
    """
    Test Claude Code CLI directly without hooks.
    Validates that Claude responds correctly.

    NOTE: This test requires Claude Code to be installed with valid auth.
    """
    claude_path = find_claude()
    if not claude_path:
        pytest.skip("Claude command not found in PATH")

    workdir = Path(os.getcwd())

    # Raw CLI subprocess — the ModelTier enum can't pass through, and `haiku`
    # IS claude's small model, so a raw `--model haiku` selects the cheap tier.
    claude_process = run_claude(workdir, prompt="reply with single word - hi", extra_args=["--model", "haiku"])

    try:
        stdout, stderr = claude_process.communicate(timeout=30)
    except subprocess.TimeoutExpired:
        claude_process.kill()
        stdout, stderr = claude_process.communicate()

    if "invalid api key" in stdout.lower():
        pytest.skip("Claude authentication required")

    assert stdout, "Claude produced no output"
    assert "hi" in stdout.lower(), f"Expected 'hi' in response, got: {stdout}"


@asynccontextmanager
async def _serve_process_hook_route(server_json_path: Path):
    """Expose the production webhook route over a real local TCP socket."""
    import uvicorn
    from fastapi import FastAPI

    from flow_sdk.server.routes.webhook import webhook_router

    ready = asyncio.Event()

    @asynccontextmanager
    async def lifespan(_app):
        ready.set()
        yield

    app = FastAPI(lifespan=lifespan)
    app.include_router(webhook_router)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    sock.listen()
    port = sock.getsockname()[1]
    server_json_path.parent.mkdir(parents=True, exist_ok=True)
    server_json_path.write_text(
        json.dumps(
            {
                "port": port,
                "server_pid": os.getpid(),
                "webhook_path": "/api/v1/webhook/listen",
                "health_path": "/api/v1/health/status",
            }
        ),
        encoding="utf-8",
    )
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    await ready.wait()
    try:
        yield
    finally:
        server.should_exit = True
        await task
        sock.close()


@pytest.mark.asyncio
async def test_process_hook_acceptance_uses_real_claude_plugin(
    initialize_test_db,
    monkeypatch,
    tmp_path,
):
    """A live headless Claude turn delivers its generated process plugin hook."""
    if not find_claude():
        pytest.skip("Claude command not found in PATH")

    from flow_sdk.builtin.agent_hook import HookEventType
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.core.capabilities.discovery import run_discovery
    from flow_sdk.core.capabilities.models import CapabilityKind
    from flow_sdk.flowpad_types.enums import WorkerType
    from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings

    monkeypatch.setenv("FLOW_HOME", str(tmp_path / "flow-home"))
    monkeypatch.setenv("FLOW_INSTANCE", "process-hook-acceptance")
    monkeypatch.setenv("LOCAL_SERVER_PORT", "0")
    monkeypatch.setenv("FLOWPAD_SKIP_LOCK", "true")
    reset_instance_settings()
    settings = get_instance_settings()
    await run_discovery([CapabilityKind.CLAUDE_CLI.value])
    process = await AgenticProcess(
        worker_type=WorkerType.CLAUDE_CODE,
        workdir=str(tmp_path),
        visible=False,
        pty_mode=False,
        load_flowpad_assistant=False,
        cli_config={
            "model": "sm",
            "effort": "low",
            "permission_mode": "bypassPermissions",
        },
    ).save()

    reports = []
    # SessionEnd is not awaited: claude defers it to real session teardown.
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
        assert rehydrated.process_hook_events == _HOOK_CONTRACT["expected_persisted_session_events"]

        async with _serve_process_hook_route(settings.server_json_path):
            result = await process.prompt(_HOOK_CONTRACT["prompt"])
            assert result.status == "SUCCESS", result
            await asyncio.gather(*(arrived.wait() for arrived in seen.values()))

            by_event = {report.hook_data["hook_event_name"]: report for report in reports}
            assert set(by_event) >= {event.value for event in awaited}, list(by_event)

            report = by_event[_HOOK_CONTRACT["event"]]
            assert report.agentic_process_id == process.id
            assert report.hook_data["prompt"] == _HOOK_CONTRACT["expected_callback_prompt"]
            assert report.hook_data["raw_hook_data"]["prompt"] == _HOOK_CONTRACT["prompt"]

            for event_name, report in by_event.items():
                assert report.agentic_process_id == process.id
                assert report.hook_data["session_id"]
                discriminator = _HOOK_CONTRACT["session_discriminators"].get(event_name)
                if discriminator:
                    assert report.hook_data[discriminator]
                    assert "prompt" not in report.hook_data

            plugin = process._process_assets_path() / _HOOK_CONTRACT["plugin_relative_path"]
            assert all((plugin / relative).is_file() for relative in _HOOK_CONTRACT["plugin_files"])
            hooks = json.loads((plugin / "hooks" / "hooks.json").read_text(encoding="utf-8"))
            assert sorted(hooks["hooks"]) == _HOOK_CONTRACT["expected_persisted_session_events"]
            handler = hooks["hooks"][_HOOK_CONTRACT["event"]][0]["hooks"][0]
            # UserPromptSubmit is a response event: claude reads the hook's stdout,
            # so the handler both reports AND blocks on the backend round trip.
            assert handler["args"][-4:] == ["report", "--process-id", process.id, "--wait-for-response"]
    finally:
        for event in configured:
            await process.remove_hook(event)
        unsubscribe()
        unsubscribe()
        await process.delete()
        reset_instance_settings()
