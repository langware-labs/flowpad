import json

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess, ProcessStatus
from flow_sdk.builtin.tab import Tab
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings


@pytest.fixture(autouse=True)
def codex_home(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    reset_instance_settings()
    yield
    reset_instance_settings()


@pytest.mark.parametrize("entry_point", ["bind", "idle_flush"])
async def test_codex_session_stamps_initial_name_and_tab(entry_point):
    sid = mint_uuid()
    path = get_instance_settings().codex_sessions_dir / f"rollout-2026-09-10T10-00-00-{sid}.jsonl"
    entries = [{"type": "session_meta", "payload": {"id": sid, "cwd": "/repo"}}]
    entries += [
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": text},
                ],
            },
        }
        for text in (
            "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>injected</INSTRUCTIONS>",
            "<environment_context>injected</environment_context>",
            "Review the plan",
            "A later prompt",
        )
    ]
    entries.append({"type": "event_msg", "payload": {"type": "task_complete"}})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(entry) + "\n" for entry in entries))
    proc = AgenticProcess(
        id=mint_uuid(),
        worker_type=WorkerType.CODEX,
        status=ProcessStatus.RUNNING,
        session_id=sid if entry_point == "idle_flush" else None,
    )
    await proc.save()
    tab = Tab(id=mint_uuid(), target_type=proc.type, target_id=proc.id)
    await tab.save()
    if entry_point == "bind":
        await proc.set_session_id(sid)
    else:
        await proc._flush_transcript_change()
    assert proc.name == "Review the plan"
    assert (await Tab.get_by_id(tab.id)).name == proc.name
    assert proc.auto_rename is True
    assert await proc.stamp_default_name() is False
    await proc.rename("My chosen name")
    await proc.set_session_id(sid)
    assert proc.name == "My chosen name"
    assert proc.auto_rename is False


async def test_late_codex_index_name_reaches_tab_without_transcript_change(monkeypatch):
    """The native title sidecar changes after the answer, with no browser mounted."""
    import asyncio

    from flow_sdk.builtin.agentic_process.naming.runtime import shutdown_name_observation
    from flow_sdk.builtin.agentic_process.naming.state import SessionNameState

    sid = mint_uuid()
    proc = AgenticProcess(id=mint_uuid(), worker_type=WorkerType.CODEX,
                          status=ProcessStatus.RUNNING, session_id=sid,
                          naming_state=SessionNameState())
    await proc.save()
    tab = Tab(id=mint_uuid(), target_type=proc.type, target_id=proc.id)
    await tab.save()
    path = get_instance_settings().codex_session_index_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('')
    await proc.reconcile_name(first_prompt="Explain blue oceans")
    published = asyncio.Event()
    original_notify = AgenticProcess.notify_updated

    async def notify(self, *args, **kwargs):
        if self.id == proc.id and self.name == "Why oceans look blue":
            published.set()
        await original_notify(self, *args, **kwargs)

    monkeypatch.setattr(AgenticProcess, 'notify_updated', notify)
    try:
        await asyncio.to_thread(path.write_text, json.dumps({
            "id": sid, "thread_name": "Why oceans look blue", "updated_at": "2026-09-13T09:00:00Z",
        }) + '\n')
        await published.wait()
        assert (await Tab.get_by_id(tab.id)).name == "Why oceans look blue"
        assert (await AgenticProcess.get_by_id(proc.id)).naming_state.phase == "protected_unknown"
    finally:
        await shutdown_name_observation()
