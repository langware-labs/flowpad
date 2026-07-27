"""End-to-end lifecycle of a NESTED repo-asset tree, all real, no mocks:

  create tree (deploy nesting)  →  index (records + relationships + search)
  →  pack into a .flowmsg        →  unpack + install into a fresh root
  →  re-index the receiver       →  the full hierarchy is reconstructed.

A parent ``task`` (REPO, folder-backed) with a child ``task`` nested inside its
own ``agentic-assets/`` subfolder. Fast: real test DB + real FSIndexer + real
pack/unpack/install over a two-node tree in tmp.
"""
from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

import pytest

import flow_sdk.fs_store.indexer.registrations  # noqa: F401  (register types)
from flow_sdk.fs_store.placement import AGENTIC_ASSETS_DIR

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase without approval


@pytest.fixture
def env(tmp_path: Path, monkeypatch):
    """Sandbox home (user scope root) + records root + embedded storage."""
    from flow_sdk.config import default_service_config
    from flow_sdk.fs_store.record_paths import (
        get_default_records_data_root,
        get_default_records_root,
        set_default_records_data_root,
        set_default_records_root,
    )
    from flow_sdk.instance_settings import reset_instance_settings
    from flow_sdk.request_context import methods as _ctx
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    home = tmp_path / "home"
    home.mkdir()
    records = tmp_path / "records"
    records.mkdir()
    orig_root, orig_data = get_default_records_root(), get_default_records_data_root()
    set_default_records_root(records)
    set_default_records_data_root(records)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(home))
    prev_dev = default_service_config.development
    default_service_config.development = True
    _ctx.set_default_test_storage_fallback(LocalStorageDriver(str(records / "blobs")))
    reset_instance_settings()
    try:
        yield tmp_path
    finally:
        _ctx.set_default_test_storage_fallback(None)
        default_service_config.development = prev_dev
        set_default_records_root(orig_root)
        set_default_records_data_root(orig_data)
        reset_instance_settings()


def _task_folder(entity) -> Path:
    return Path(entity.asset_ref)


async def test_repo_nested_tree_full_lifecycle(env):
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
    from flow_sdk.builtin.flow_message_bundle import (
        _reindex_root,
        pack_bundle,
        unpack_bundle,
    )
    from flow_sdk.builtin.task import Task
    from flow_sdk.fs_store.record_types import RecordType

    home = env / "home"
    aa = AGENTIC_ASSETS_DIR

    # ── 1. CREATE the tree via the real deploy path ────────────────────────
    parent = Task(title="Ship Parent", status="in_progress")
    await parent.save(notify=False)
    child = Task(title="Ship Child", status="in_progress", parent_type_id=f"task-{parent.id}")
    await child.save(notify=False)

    p_dir, c_dir = _task_folder(parent), _task_folder(child)
    # Deploy nesting: parent at <home>/agentic-assets/task/<name>; child inside it.
    assert p_dir == home / aa / "task" / p_dir.name
    assert (p_dir / "task.md").is_file()
    assert p_dir in c_dir.parents, f"child {c_dir} not nested under parent {p_dir}"
    assert c_dir.relative_to(p_dir).parts[:2] == (aa, "task")
    assert (c_dir / "task.md").is_file()

    # ── 2. INDEX (records + relationships + search) ────────────────────────
    await _reindex_root(home, RecordType.USER_HOME_FOLDER, types=(RecordType.TASK,))
    p_row = await Task.get_one({"id": parent.id})
    c_row = await Task.get_one({"id": child.id})
    assert p_row is not None and c_row is not None, "both task rows must materialize"
    # relationship: the nested child points at its parent
    assert c_row.parent_type_id == f"task-{parent.id}", "child lost its parent link on index"
    # search: FTS5 finds both levels by title content
    from flow_sdk.core.entity.entity_model import Entity

    hits = await Entity.search(query="Ship", record_type="task", limit=50)
    found = {getattr(e, "id", None) for e in hits}
    assert parent.id in found and child.id in found, f"search missed a level: {found}"

    # ── 3. PACK the parent into a .flowmsg (child rides along) ──────────────
    fm = FlowMessage(id="aaaaaaaa-0000-0000-0000-000000000001", text="carrier")
    fm.attachment = [Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"task-{parent.id}")]
    zip_path = await pack_bundle(fm, dest_dir=env / "out")
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
    parent_arc = f"attachment/task-{parent.id}/{aa}/task/{p_dir.name}/task.md"
    child_arc = f"attachment/task-{parent.id}/{aa}/task/{p_dir.name}/{aa}/task/{c_dir.name}/task.md"
    assert parent_arc in names, f"parent not packed: {names}"
    assert child_arc in names, f"NESTED CHILD not packed: {names}"
    # entities.json carries the metadata axis for BOTH levels (the child's
    # parent link lives only here — the body never carried it).
    import json as _json

    with zipfile.ZipFile(zip_path) as zf:
        ent_map = _json.loads(zf.read("entities.json"))
    assert f"task-{child.id}" in ent_map, f"child envelope missing: {sorted(ent_map)}"
    assert ent_map[f"task-{child.id}"]["parent_type_id"] == f"task-{parent.id}"
    assert "project_id" not in ent_map[f"task-{child.id}"], "sender project_id leaked"

    # Simulate a genuinely fresh receiver: no sender DB rows or source tree.
    # Keeping the source tree live would correctly trigger duplicate-id skip.
    await (await Task.get_one({"id": child.id})).destroy()
    await (await Task.get_one({"id": parent.id})).destroy()
    shutil.rmtree(home / aa)
    assert await Task.get_one({"id": parent.id}) is None

    # ── 4. UNPACK + INSTALL into a fresh project root ──────────────────────
    from flow_sdk.app.actions.message_attachment_action import handle_attachment_install
    from flow_sdk.builtin.message_attachment import MessageAttachment
    from flow_sdk.builtin.project import Project
    from flow_sdk.responses.response import ApiSuccessResponse

    receiver = env / "receiver"
    receiver.mkdir()
    project = Project(name="dst", fs_storage_mount_path=str(receiver))
    await project.save(notify=False)

    await unpack_bundle(zip_path, "local-user-id")
    entry_key = f"task-{parent.id}"
    ma = await MessageAttachment.get_one(
        {"id": MessageAttachment.allocate_deterministic_id(fm.id, entry_key)}
    )
    assert ma is not None, "unpack did not stage the parent task"
    res = await handle_attachment_install(ma.id, "project", project.id)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)

    # ── 5. VALIDATE reconstruction + metadata overlay on the receiver ──────
    r_parent = receiver / aa / "task" / p_dir.name
    r_child = r_parent / aa / "task" / c_dir.name
    assert (r_parent / "task.md").is_file(), "parent task.md not reconstructed"
    assert (r_child / "task.md").is_file(), "NESTED CHILD task.md not reconstructed"

    p2 = await Task.get_one({"id": parent.id})
    c2 = await Task.get_one({"id": child.id})
    assert p2 is not None and c2 is not None, "install did not materialize both levels"
    # The child's parent link survives — restored from entities.json, not the body.
    assert c2.parent_type_id == f"task-{parent.id}", "child lost parent link after round-trip"
    # Sender-local project_id is MINTED on the receiver, never adopted.
    assert p2.project_id == project.id and c2.project_id == project.id
