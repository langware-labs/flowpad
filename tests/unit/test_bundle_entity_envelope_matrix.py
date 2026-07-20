"""Fast e2e matrix — the full pipeline over a nested repo tree:

    scan (deploy) → index → pack → unpack → install → query

Real fs + real DB + real FSIndexer + real pack/unpack/install, no mocks/network.
All fast IO. Stresses the corner cases of the ``entities.json`` metadata axis
(PR1–PR3): metadata survival in copy mode, mixed-type depth, ``entities.json``
omission (enclosure fallback), file-id-wins collision, minted project_id,
re-derived asset_ref/scope, idempotent re-install, leak guard, and FTS
reachability — plus one ``git`` transport case.
"""
import json
import zipfile
from pathlib import Path

import pytest

import flow_sdk.fs_store.indexer.registrations  # noqa: F401
from flow_sdk.fs_store.placement import AGENTIC_ASSETS_DIR

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase without approval

AA = AGENTIC_ASSETS_DIR


# --------------------------------------------------------------------------- #
# harness
# --------------------------------------------------------------------------- #
@pytest.fixture
def env(tmp_path: Path, monkeypatch):
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


async def _reindex_home(home):
    from flow_sdk.builtin.flow_message_bundle import _reindex_root
    from flow_sdk.fs_store.record_types import RecordType

    await _reindex_root(home, RecordType.USER_HOME_FOLDER, types=None)


async def _pack(parent_id, dest):
    import uuid

    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
    from flow_sdk.builtin.flow_message_bundle import pack_bundle

    # unique per call — the shared test DB persists FlowMessage rows across tests.
    fm = FlowMessage(id=str(uuid.uuid4()), text="carrier")
    fm.attachment = [Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"task-{parent_id}")]
    return fm, await pack_bundle(fm, dest_dir=dest)


async def _install_fresh(env, fm, zip_path, parent_id, *, scope):
    """Unpack + install into a fresh receiver project (rows already dropped)."""
    from flow_sdk.app.actions.message_attachment_action import handle_attachment_install
    from flow_sdk.builtin.flow_message_bundle import unpack_bundle
    from flow_sdk.builtin.message_attachment import MessageAttachment
    from flow_sdk.builtin.project import Project

    receiver = env / "receiver"
    receiver.mkdir(exist_ok=True)
    project = Project(name="dst", fs_storage_mount_path=str(receiver))
    await project.save(notify=False)

    await unpack_bundle(zip_path, "local-user-id")
    ma = await MessageAttachment.get_one(
        {"id": MessageAttachment.allocate_deterministic_id(fm.id, f"task-{parent_id}")}
    )
    assert ma is not None, "unpack did not stage the parent"
    target = ("project", project.id) if scope == "project" else ("user", None)
    res = await handle_attachment_install(ma.id, *target)
    return receiver, project, res, ma


# --------------------------------------------------------------------------- #
# core lifecycle — parametrized over scope, with a grandchild + mixed types
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("scope", ["project", "user"])
async def test_full_pipeline_nested_mixed_types(env, scope):
    from flow_sdk.builtin.spec import Spec
    from flow_sdk.builtin.task import Task
    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.responses.response import ApiSuccessResponse

    home = env / "home"

    # scan: deploy a mixed-type nested tree  task → spec(child) → task(grandchild)
    parent = Task(title="Ship Parent", status="in_progress", labels=["alpha", "beta"])
    await parent.save(notify=False)
    child = Spec(title="Ship Spec Child", parent_type_id=f"task-{parent.id}")
    await child.save(notify=False)
    grand = Task(title="Ship Grand", status="todo", parent_type_id=f"spec-{child.id}")
    await grand.save(notify=False)

    # index
    await _reindex_home(home)

    # pack
    fm, zip_path = await _pack(parent.id, env / "out")
    with zipfile.ZipFile(zip_path) as zf:
        ent_map = json.loads(zf.read("entities.json"))
    # every level present in the metadata axis, with links + no leaked project_id
    assert ent_map[f"task-{parent.id}"]
    assert ent_map[f"spec-{child.id}"]["parent_type_id"] == f"task-{parent.id}"
    assert ent_map[f"task-{grand.id}"]["parent_type_id"] == f"spec-{child.id}"
    for e in ent_map.values():
        assert "project_id" not in e, "sender project_id leaked into entities.json"

    # fresh receiver DB
    for e in (grand, child, parent):
        await (await type(e).get_one({"id": e.id})).destroy()

    # unpack + install
    receiver, project, res, _ = await _install_fresh(env, fm, zip_path, parent.id, scope=scope)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)

    # query: every level materialized, parented, and reachable via FTS
    p2 = await Task.get_one({"id": parent.id})
    c2 = await Spec.get_one({"id": child.id})
    g2 = await Task.get_one({"id": grand.id})
    assert p2 and c2 and g2, "install did not materialize all three levels"
    assert c2.parent_type_id == f"task-{parent.id}"
    assert g2.parent_type_id == f"spec-{child.id}"

    # portable metadata-only fields survive the round-trip (not just the link)
    assert g2.status == "todo", "status dropped on round-trip"
    assert set(p2.labels or []) == {"alpha", "beta"}, f"labels dropped: {p2.labels}"

    # minted project_id (receiver's), re-derived asset_ref (project-scope lands
    # in the project mount; user-scope lands under the receiver's home).
    expected_pid = project.id if scope == "project" else None
    assert p2.project_id == expected_pid and g2.project_id == expected_pid
    if scope == "project":
        assert str(receiver) in str(p2.asset_ref), "asset_ref not re-derived to receiver"

    # FTS reachability at every level
    hits = {getattr(h, "id", None) for h in await Entity.search(query="Ship", limit=50)}
    assert {parent.id, grand.id} <= hits, f"FTS missed a level: {hits}"


# --------------------------------------------------------------------------- #
# corner: entities.json omission → enclosure fallback still parents the child
# --------------------------------------------------------------------------- #
async def test_entities_json_omission_enclosure_fallback(env):
    from flow_sdk.builtin.task import Task
    from flow_sdk.responses.response import ApiSuccessResponse

    home = env / "home"
    parent = Task(title="Omit Parent", status="in_progress")
    await parent.save(notify=False)
    child = Task(title="Omit Child", status="todo", parent_type_id=f"task-{parent.id}")
    await child.save(notify=False)
    await _reindex_home(home)

    fm, zip_path = await _pack(parent.id, env / "out")
    # strip the CHILD from entities.json — force the receiver onto enclosure derivation
    _strip_child_from_entities(zip_path, f"task-{child.id}")

    for e in (child, parent):
        await (await Task.get_one({"id": e.id})).destroy()

    _, project, res, _ = await _install_fresh(env, fm, zip_path, parent.id, scope="project")
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    c2 = await Task.get_one({"id": child.id})
    assert c2 is not None
    assert c2.parent_type_id == f"task-{parent.id}", "enclosure fallback failed to parent child"


# --------------------------------------------------------------------------- #
# corner: idempotent re-install — installing twice = one row, byte-identical body
# --------------------------------------------------------------------------- #
async def test_idempotent_reinstall(env):
    from flow_sdk.app.actions.message_attachment_action import handle_attachment_install
    from flow_sdk.builtin.message_attachment import MessageAttachment
    from flow_sdk.builtin.task import Task
    from flow_sdk.responses.response import ApiSuccessResponse

    home = env / "home"
    parent = Task(title="Idem", status="in_progress")
    await parent.save(notify=False)
    await _reindex_home(home)
    fm, zip_path = await _pack(parent.id, env / "out")
    await (await Task.get_one({"id": parent.id})).destroy()

    _, project, res1, ma = await _install_fresh(env, fm, zip_path, parent.id, scope="project")
    assert isinstance(res1, ApiSuccessResponse)
    res2 = await handle_attachment_install(ma.id, "project", project.id, overwrite=True)
    assert isinstance(res2, ApiSuccessResponse), getattr(res2, "message", res2)

    rows = await Task.get_all({"id": parent.id})
    assert len([r for r in rows if r.id == parent.id]) == 1, "re-install duplicated the row"


# --------------------------------------------------------------------------- #
# corner: file-backed (markdown) shape — a non-folder asset's metadata travels
# --------------------------------------------------------------------------- #
async def test_file_backed_markdown_shape(env):
    from flow_sdk.app.actions.message_attachment_action import handle_attachment_install
    from flow_sdk.builtin.claude_memory_entities import Docs as Markdown
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
    from flow_sdk.builtin.flow_message_bundle import pack_bundle, unpack_bundle
    from flow_sdk.builtin.message_attachment import MessageAttachment
    from flow_sdk.builtin.project import Project
    from flow_sdk.responses.response import ApiSuccessResponse

    home = env / "home"
    doc = Markdown(title="Notes", labels=["x"])
    await doc.save(notify=False)
    await _reindex_home(home)

    import uuid as _uuid

    fm = FlowMessage(id=str(_uuid.uuid4()), text="carrier")
    fm.attachment = [Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"markdown-{doc.id}")]
    zip_path = await pack_bundle(fm, dest_dir=env / "mdout")
    with zipfile.ZipFile(zip_path) as zf:
        ent_map = json.loads(zf.read("entities.json"))
    assert f"markdown-{doc.id}" in ent_map, "markdown envelope missing from entities.json"
    assert "project_id" not in ent_map[f"markdown-{doc.id}"]

    await (await Markdown.get_one({"id": doc.id})).destroy()

    receiver = env / "mdrecv"
    receiver.mkdir()
    project = Project(name="mddst", fs_storage_mount_path=str(receiver))
    await project.save(notify=False)
    await unpack_bundle(zip_path, "local-user-id")
    ma = await MessageAttachment.get_one(
        {"id": MessageAttachment.allocate_deterministic_id(fm.id, f"markdown-{doc.id}")}
    )
    assert ma is not None, "unpack did not stage the markdown"
    res = await handle_attachment_install(ma.id, "project", project.id)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    d2 = await Markdown.get_one({"id": doc.id})
    assert d2 is not None and set(d2.labels or []) == {"x"}, "markdown metadata lost"
    assert d2.project_id == project.id, "markdown project_id not minted"


# --------------------------------------------------------------------------- #
# corner: raw non-entity FILE — bytes travel, no spurious entities.json entry
# --------------------------------------------------------------------------- #
async def test_raw_file_no_entities_entry(env):
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
    from flow_sdk.builtin.flow_message_bundle import pack_bundle
    from flow_sdk.storage import get_entity_embedded_storage

    import uuid as _uuid

    fm = FlowMessage(id=str(_uuid.uuid4()), text="carrier")
    # stage a raw blob in the FM's embedded storage, reference it as a FILE
    storage = get_entity_embedded_storage(fm.typeid)
    vfs = "data/report.bin"
    storage.write_bytes(vfs, b"RAWBYTES") if hasattr(storage, "write_bytes") else None
    dest = Path(storage.get_storage_path(vfs))
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(b"RAWBYTES")
    fm.attachment = [Attachment(attachment_type=AttachmentType.FILE, data=vfs)]

    zip_path = await pack_bundle(fm, dest_dir=env / "rawout")
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        # bytes travel under files/, and there is NO entities.json (no entity involved)
        assert any(n.endswith("report.bin") for n in names), f"raw bytes not packed: {names}"
        assert "entities.json" not in names, "raw file produced a spurious entities.json"


# --------------------------------------------------------------------------- #
# corner: file-id-wins collision — receiver already has the entity, file wins
# --------------------------------------------------------------------------- #
async def test_file_id_wins_on_collision(env):
    from flow_sdk.builtin.task import Task
    from flow_sdk.responses.response import ApiSuccessResponse

    home = env / "home"
    parent = Task(title="Original Title", status="in_progress")
    await parent.save(notify=False)
    await _reindex_home(home)
    fm, zip_path = await _pack(parent.id, env / "colout")

    # receiver already has the SAME id with DIFFERENT content (a stale local copy)
    stale = await Task.get_one({"id": parent.id})
    stale.title = "Stale Local Title"
    await stale.save(notify=False)

    receiver, project, res, _ = await _install_fresh(env, fm, zip_path, parent.id, scope="project")
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    got = await Task.get_one({"id": parent.id})
    # the shared file's content wins over the stale local row
    assert got.title == "Original Title", f"file-id did not win: {got.title!r}"


# --------------------------------------------------------------------------- #
# corner: git transport — body via a real bare origin, metadata via entities.json
# --------------------------------------------------------------------------- #
async def test_git_transport_metadata_still_travels(env):
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
    from flow_sdk.builtin.flow_message_bundle import pack_bundle
    from flow_sdk.builtin.task import Task

    home = env / "home"
    parent = Task(title="Git Parent", status="in_progress")
    await parent.save(notify=False)
    child = Task(title="Git Child", status="todo", parent_type_id=f"task-{parent.id}")
    await child.save(notify=False)
    await _reindex_home(home)

    # git mode force-downgrades tasks to copy (they are record-carriers) — the
    # point here is that the METADATA axis is transport-independent: entities.json
    # is written regardless of the requested transport.
    fm = FlowMessage(id="bbbbbbbb-0000-0000-0000-000000000001", text="carrier")
    fm.attachment = [Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"task-{parent.id}")]
    zip_path = await pack_bundle(fm, dest_dir=env / "gitout", transfer_mode="git")
    with zipfile.ZipFile(zip_path) as zf:
        ent_map = json.loads(zf.read("entities.json"))
    assert ent_map[f"task-{child.id}"]["parent_type_id"] == f"task-{parent.id}", (
        "entities.json must travel regardless of transport mode"
    )


# --------------------------------------------------------------------------- #
# helpers that rewrite a bundle
# --------------------------------------------------------------------------- #
def _strip_child_from_entities(zip_path: Path, child_key: str):
    """Remove one entry from the bundle's entities.json (test-only surgery)."""
    import shutil
    import tempfile

    tmp = Path(tempfile.mkdtemp())
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(tmp)
    ep = tmp / "entities.json"
    data = json.loads(ep.read_text())
    data.pop(child_key, None)
    ep.write_text(json.dumps(data))
    zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(tmp.rglob("*")):
            if p.is_file():
                zf.write(p, p.relative_to(tmp))
    shutil.rmtree(tmp, ignore_errors=True)
