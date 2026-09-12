"""Public naming lifecycle exercised with persisted entities and native metadata."""

import json

import pytest
from starlette.requests import Request

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess, ProcessStatus
from flow_sdk.builtin.agentic_process.naming.state import NamePhase, SessionNameState
from flow_sdk.builtin.tab import Tab
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings
from flow_sdk.request_context.execution_context import (
    ExecutionContext,
    get_execution_context,
    set_execution_context,
)


@pytest.fixture(autouse=True)
def claude_home(tmp_path, monkeypatch):
    directory = str(tmp_path / "claude")
    monkeypatch.setenv("FLOWPAD_CLAUDE_HOME", directory)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", directory)
    reset_instance_settings()
    yield
    reset_instance_settings()


async def _proc(**kwargs):
    if not kwargs.get("name"):
        kwargs.setdefault("naming_state", SessionNameState(session_id=kwargs.get("session_id")))
    process = AgenticProcess(id=mint_uuid(), worker_type=WorkerType.CLAUDE_CODE_CLI,
                             status=ProcessStatus.STOPPED, **kwargs)
    await process.save()
    return process


def _write_transcript(sid, *, prompt="why is the tab name not proper?", title=None):
    rows = [{"type": "user", "message": {"role": "user", "content": prompt},
             "uuid": mint_uuid(), "sessionId": sid, "cwd": "/repo", "isSidechain": False,
             "entrypoint": "sdk-cli", "timestamp": "2026-09-13T00:00:00Z"},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Looking into it."}]},
             "uuid": mint_uuid(), "sessionId": sid, "cwd": "/repo"}]
    if title is not None:
        rows.append({"type": "ai-title", "aiTitle": title, "sessionId": sid})
    path = get_instance_settings().claude_projects_dir / "-repo" / f"{sid}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    return path


async def _tab(process, *, name=None):
    tab = Tab(id=mint_uuid(), target_type=process.type, target_id=process.id, name=name)
    await tab.save()
    return tab


async def _rename_action(process, name):
    """Give the real action a real ASGI request, with no patched body reader."""
    async def receive():
        return {"type": "http.request", "body": json.dumps({"name": name}).encode(), "more_body": False}

    request = Request({"type": "http", "method": "POST", "path": "/rename", "headers": []}, receive)
    previous = get_execution_context()
    try:
        async with ExecutionContext.create() as context:
            context.request_info.request = request
            return await process._rename_action()
    finally:
        set_execution_context(previous)


async def test_stamps_subject_and_keeps_auto_rename():
    sid = mint_uuid()
    _write_transcript(sid, title="Base directory spec")
    process = await _proc(session_id=sid)
    assert await process.stamp_default_name() is True
    durable = await AgenticProcess.get_by_id(process.id)
    assert process.name == durable.name == "Base directory spec"
    assert durable.auto_rename is True and durable.naming_state.phase is NamePhase.HARNESS


async def test_stamp_mirrors_name_onto_open_tab():
    sid = mint_uuid()
    _write_transcript(sid, title="Base directory spec")
    process = await _proc(session_id=sid)
    tab = await _tab(process, name=f"agentic_process-{process.id[:4]}…{process.id[-4:]}")
    assert await process.stamp_default_name() is True
    assert (await Tab.get_by_id(tab.id)).name == process.name == "Base directory spec"
    assert process.auto_rename is True


async def test_noop_when_existing_user_name_is_set():
    sid = mint_uuid()
    _write_transcript(sid, title="Automatic title")
    process = await _proc(session_id=sid, name="Existing name")
    assert await process.stamp_default_name() is False
    assert process.name == "Existing name" and process.naming_state.protected


async def test_noop_when_user_pinned():
    sid = mint_uuid()
    _write_transcript(sid, title="Automatic title")
    process = await _proc(session_id=sid)
    await process.rename("Pinned name")
    assert await process.stamp_default_name() is False
    assert process.name == "Pinned name" and process.auto_rename is False


async def test_noop_when_no_session():
    process = await _proc()
    assert await process.stamp_default_name() is False
    assert process.session_id is None and process.name is None


async def test_headless_sdk_session_still_gets_a_default_name():
    sid = mint_uuid()
    _write_transcript(sid)
    process = await _proc(session_id=sid, pty_mode=False)
    assert await process.stamp_default_name() is True
    assert process.name == "why is the tab name not proper?"
    assert process.auto_rename is True and process.naming_state.phase is NamePhase.PROMPT_FALLBACK
    assert await process.stamp_default_name() is False


async def test_delayed_stamp_does_not_resurrect_deleted_process():
    sid = mint_uuid()
    _write_transcript(sid, title="Late worker title")
    process = await _proc(session_id=sid)
    stale = await AgenticProcess.get_by_id(process.id)
    await process.delete()
    assert await stale.stamp_default_name() is False
    assert await AgenticProcess.get_by_id(process.id) is None


async def test_noop_when_no_subject_yet():
    process = await _proc(session_id=mint_uuid())
    assert await process.stamp_default_name() is False
    assert process.name is None


async def test_rename_action_pins_and_mirrors_onto_open_tab():
    process = await _proc(session_id=mint_uuid())
    tab = await _tab(process)
    result = await _rename_action(process, "My renamed run")
    assert result.status != "FAIL"
    durable = await AgenticProcess.get_by_id(process.id)
    assert durable.name == (await Tab.get_by_id(tab.id)).name == "My renamed run"
    assert durable.auto_rename is False


async def test_rename_action_headless_no_tab_still_persists():
    process = await _proc(session_id=mint_uuid(), pty_mode=False)
    await _rename_action(process, "Headless renamed")
    durable = await AgenticProcess.get_by_id(process.id)
    assert durable.name == "Headless renamed" and durable.auto_rename is False
    assert await Tab.get_all({"target_type": process.type, "target_id": process.id}) == []


async def test_rename_action_rejects_empty_name():
    process = await _proc(session_id=mint_uuid())
    result = await _rename_action(process, "   ")
    assert result.status == "FAIL"
    assert (await AgenticProcess.get_by_id(process.id)).name is None


async def test_terminal_first_prompt_event_names_before_native_session_exists():
    from urllib.parse import urlencode

    process = await _proc()
    tab = await _tab(process)
    request = Request({"type": "http", "method": "GET", "path": "/report_event/first_prompt",
                       "headers": [], "query_string": urlencode({"data": json.dumps({
                           "prompt": "Explain blue oceans", "sent_at": "2026-09-13T00:00:00Z",
                       })}).encode()})
    previous = get_execution_context()
    try:
        async with ExecutionContext.create() as context:
            context.request_info.request = request
            context.request_info.sub_path = "first_prompt"
            context.request_info.request_parameters = dict(request.query_params)
            result = await process.report_event_action()
        assert result.data["accepted"] is True
        assert (await AgenticProcess.get_by_id(process.id)).name == "Explain blue oceans"
        assert (await Tab.get_by_id(tab.id)).name == "Explain blue oceans"
    finally:
        set_execution_context(previous)
