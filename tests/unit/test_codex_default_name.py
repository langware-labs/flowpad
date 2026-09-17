import json

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess, ProcessStatus
from flow_sdk.builtin.tab import Tab
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings

from .conftest import settle_transcript_flushes


@pytest.fixture(autouse=True)
def codex_home(tmp_path, monkeypatch):
    # ``.codex`` in the path is how a delivered transcript is attributed to its vendor.
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / ".codex"))
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


def _rollout(sid: str, *, cwd: str = "/repo"):
    path = get_instance_settings().codex_sessions_dir / "2026" / "09" / "16" / f"rollout-2026-09-16T10-00-00-{sid}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [
        {"type": "session_meta", "payload": {"id": sid, "cwd": cwd}},
        {"type": "response_item", "payload": {"type": "message", "role": "user",
                                              "content": [{"type": "input_text", "text": "Explain blue oceans"}]}},
    ]
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    return path


@pytest.mark.long  # ~1.1s: the transcript flush debounce is a real 1s window
async def test_codex_index_title_applies_on_the_next_transcript_event():
    """The native title sidecar is read when the session's transcript next moves."""
    from flow_sdk.builtin.agentic_process.naming.state import SessionNameState
    from flow_sdk.transcript_streamer.registry import transcript_streamer_registry

    sid = mint_uuid()
    proc = AgenticProcess(id=mint_uuid(), worker_type=WorkerType.CODEX, status=ProcessStatus.RUNNING,
                          session_id=sid, workdir="/repo", naming_state=SessionNameState())
    await proc.save()
    tab = Tab(id=mint_uuid(), target_type=proc.type, target_id=proc.id)
    await tab.save()
    index = get_instance_settings().codex_session_index_path
    index.parent.mkdir(parents=True, exist_ok=True)
    index.write_text(json.dumps({
        "id": sid, "thread_name": "Why oceans look blue", "updated_at": "2026-09-16T10:00:00Z",
    }) + "\n")

    await transcript_streamer_registry.notify_change(_rollout(sid))
    await settle_transcript_flushes()

    assert (await AgenticProcess.get_by_id(proc.id)).name == "Why oceans look blue"
    assert (await Tab.get_by_id(tab.id)).name == "Why oceans look blue"


@pytest.mark.long  # ~1.1s: the transcript flush debounce is a real 1s window
async def test_terminal_typed_codex_session_is_adopted_from_its_first_transcript_event():
    """Codex mints its id after launch; the first transcript event pairs it with its process."""
    from flow_sdk.transcript_streamer.registry import transcript_streamer_registry

    sid = mint_uuid()
    proc = AgenticProcess(id=mint_uuid(), worker_type=WorkerType.CODEX, status=ProcessStatus.RUNNING,
                          workdir="/repo")
    await proc.save()
    assert not (await AgenticProcess.get_by_id(proc.id)).session_id

    await transcript_streamer_registry.notify_change(_rollout(sid))
    await settle_transcript_flushes()

    assert (await AgenticProcess.get_by_id(proc.id)).session_id == sid
