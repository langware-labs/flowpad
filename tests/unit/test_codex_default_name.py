import json

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess, ProcessStatus
from flow_sdk.builtin.tab import Tab
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings import get_instance_settings


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
