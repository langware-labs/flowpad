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
    project = await Project(name=str(tmp_path / f"project-{tmp_path.name}")).save()
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
    project = await Project(name=str(tmp_path / f"project-{tmp_path.name}")).save()
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


async def test_delete_clears_child_rows_search_and_disk_only_records(tmp_path):
    """Children come from one DB query; their search rows go with them, and a record
    that exists only on disk is swept after the delete answers."""
    from flow_sdk.db import get_db_driver
    from flow_sdk.db.drivers.sqlite.sqlite_driver import FtsEntry
    from flow_sdk.fs_store.record_paths import shadow_dir_for

    project = await Project(name=str(tmp_path / f"project-{tmp_path.name}")).save()
    from flow_sdk.builtin.bookmark import Bookmark

    chat = await Bookmark(project_id=project.id, title="zebra").save()
    driver = get_db_driver()
    from sqlalchemy import text

    async def search_rows() -> int:
        async with driver._session_ctx(write=False) as session:
            q = text("SELECT count(*) FROM entities_fts WHERE entity_id = :i")
            return (await session.execute(q, {"i": str(chat.id)})).scalar()

    await driver.fts_upsert(FtsEntry(entity_id=str(chat.id), entity_type="bookmark",
                                     name="zebra", content="zebra findme"))
    assert await search_rows() == 1
    orphan_id = mint_uuid()
    orphan = shadow_dir_for("markdown", orphan_id)
    orphan.mkdir(parents=True)
    (orphan / "metadata.json").write_text(json.dumps({"type": "markdown", "id": orphan_id, "project_id": project.id}))

    result = await project._delete_with_children(delete_chats=False)

    assert result["deleted_children"] >= 1
    assert await Bookmark.get_by_id(chat.id) is None
    assert await search_rows() == 0
    sweep = next(t for t in asyncio.all_tasks() if t.get_name() == f"project-orphans-{project.id}")
    assert await sweep == 1
    assert not orphan.exists()
