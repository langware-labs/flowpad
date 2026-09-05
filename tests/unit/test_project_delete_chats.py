"""Project deletion controls native history independently of indexed rows."""

import asyncio
import json
import sys

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.agentic_process import prompt_worker_active, register_prompt_worker
from flow_sdk.builtin.project import Project
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings


@pytest.mark.parametrize("delete_chats", [None, True, False])
async def test_project_delete_chat_history_option(tmp_path, monkeypatch, delete_chats):
    monkeypatch.setenv("FLOWPAD_CLAUDE_HOME", str(tmp_path / ".claude"))
    reset_instance_settings()
    project = await Project(name=str(tmp_path / "project")).save()
    session_id = mint_uuid()
    history = get_instance_settings().claude_projects_dir / "project-with-underscores"
    history.mkdir(parents=True)
    transcript = history / f"{session_id}.jsonl"
    transcript.write_text(json.dumps({"cwd": project.fs_storage_mount_path, "sessionId": session_id}) + "\n")
    unindexed = history / f"{mint_uuid()}.jsonl"
    unindexed.write_text(transcript.read_text())
    chat = await AgenticProcess(project_id=project.id, workdir=project.fs_storage_mount_path,
                                worker_type=WorkerType.CLAUDE_CODE, session_id=session_id).save()

    await project._delete_with_children(**({} if delete_chats is None else {"delete_chats": delete_chats}))

    assert await Project.get_by_id(project.id) is None
    assert await AgenticProcess.get_by_id(chat.id) is None
    assert transcript.exists() is (delete_chats is False)
    assert unindexed.exists() is (delete_chats is False)
    reset_instance_settings()


async def test_delete_stops_a_headless_writer_before_removing_history(tmp_path):
    project = await Project(name=str(tmp_path / "project")).save()
    chat = await AgenticProcess(project_id=project.id, pty_mode=False).save()
    worker = chat.driver.stream_worker(chat)
    child = await asyncio.create_subprocess_exec(sys.executable, "-c", "import time; time.sleep(60)")
    worker._proc = child
    register_prompt_worker(chat.id, worker)
    try:
        await project._delete_with_children(delete_chats=True)
        assert child.returncode is not None
        assert not prompt_worker_active(chat.id)
        assert await AgenticProcess.get_by_id(chat.id) is None
    finally:
        await worker.close_session()
