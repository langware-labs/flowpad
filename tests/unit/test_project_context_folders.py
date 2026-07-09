"""Unit tests for project context folders as Folder entities in context buckets.

Contract under test (no LLM, no server):

  * ``add-context-dir`` mints the Folder entity, links it into the requested
    bucket (private default / shared) with the canonical path stamped in the
    per-entry sidecar, and the computed ``include_dirs`` derives it.
  * ``remove-context-dir`` unlinks from BOTH buckets, prunes the sidecar, and
    never deletes the Folder entity or touches disk.
  * Privacy: a private folder path never appears in ``_hub_body`` (the hub
    push payload); the shared bucket entry travels but the sidecar stays local.
  * Durability: the buckets + sidecars round-trip the record's metadata.json
    (ProjectMeta) so links survive a DB rebuild.
  * Worker chain: the computed list flows through ``_project_context_dirs``
    stamping into ``resolved_add_dirs`` and the rendered ``--add-dir`` flags.
"""
import json

import pytest

from flow_sdk.builtin.folder import Folder
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.schema.type_info import register_all

register_all()


async def _make_project(tmp_path, name="ctx-proj"):
    project = Project(name=str(tmp_path / name))
    await project.save()
    return project


def _ctx_dir(tmp_path, name="extra"):
    d = tmp_path / name
    d.mkdir(exist_ok=True)
    return canonical_posix_path(str(d))


@pytest.mark.asyncio
async def test_add_context_dir_private_default(tmp_path):
    project = await _make_project(tmp_path)
    ctx = _ctx_dir(tmp_path)

    resp = await project.add_context_dir(ctx)
    assert resp.status == "SUCCESS"

    # Folder entity minted, deterministic id.
    folder = await Folder.get_by_id(Folder.id_for_path(ctx))
    assert folder is not None and folder.path == ctx

    # Linked privately with the path sidecar; computed property derives it.
    tids = project.context_of_type("folder", bucket="private")
    assert [str(t) for t in tids] == [str(folder.typeid)]
    assert project.context_of_type("folder", bucket="shared") == []
    assert (project.get_context_entry_data(folder.typeid) or {}).get("path") == ctx
    assert project.include_dirs == [ctx]
    # Action response carries the computed list (frontend adopts it).
    assert resp.data["include_dirs"] == [ctx]

    # Idempotent re-add.
    await project.add_context_dir(ctx)
    assert project.include_dirs == [ctx]
    assert len(project.context_of_type("folder", bucket="private")) == 1


@pytest.mark.asyncio
async def test_add_context_dir_shared_scope(tmp_path):
    project = await _make_project(tmp_path)
    ctx = _ctx_dir(tmp_path, "shared-extra")

    await project.add_context_dir(ctx, scope="shared")
    assert [str(t) for t in project.context_of_type("folder", bucket="shared")]
    assert project.context_of_type("folder", bucket="private") == []
    assert project.include_dirs == [ctx]

    bad = await project.add_context_dir(ctx, scope="bogus")
    assert bad.status == "FAIL"


@pytest.mark.asyncio
async def test_remove_context_dir_unlinks_both_buckets(tmp_path):
    project = await _make_project(tmp_path)
    ctx = _ctx_dir(tmp_path)
    (tmp_path / "extra" / "keep.txt").write_text("data")

    await project.add_context_dir(ctx)
    await project.add_context_dir(ctx, scope="shared")  # same folder in both buckets
    assert project.include_dirs == [ctx]

    await project.remove_context_dir(ctx)
    assert project.include_dirs == []
    assert project.context_of_type("folder", bucket="both") == []
    # Sidecars pruned.
    folder_id = Folder.id_for_path(ctx)
    assert project.get_context_entry_data((await Folder.get_by_id(folder_id)).typeid) is None

    # Folder entity survives (other projects may link it); disk untouched.
    assert await Folder.get_by_id(folder_id) is not None
    assert (tmp_path / "extra" / "keep.txt").exists()

    # No-op remove is fine.
    resp = await project.remove_context_dir(ctx)
    assert resp.status == "SUCCESS"


@pytest.mark.asyncio
async def test_private_path_never_on_the_wire(tmp_path):
    project = await _make_project(tmp_path)
    private_dir = _ctx_dir(tmp_path, "private-secret")
    shared_dir = _ctx_dir(tmp_path, "shared-pub")
    await project.add_context_dir(private_dir)
    await project.add_context_dir(shared_dir, scope="shared")

    body = project._hub_body()
    payload = json.dumps(body, default=str)
    # The computed list and the private bucket/sidecars are all excluded.
    assert "include_dirs" not in body
    assert private_dir not in payload
    assert shared_dir not in payload  # sidecar paths are local-only, both buckets
    # The shared LINK (folder typeid) travels.
    shared_tid = str((await Folder.get_by_id(Folder.id_for_path(shared_dir))).typeid)
    assert shared_tid in payload
    private_tid = str((await Folder.get_by_id(Folder.id_for_path(private_dir))).typeid)
    assert private_tid not in payload


@pytest.mark.asyncio
async def test_links_roundtrip_record_metadata(tmp_path):
    """ProjectMeta persistence: buckets + sidecars survive disk→DB re-adopt."""
    project = await _make_project(tmp_path)
    ctx = _ctx_dir(tmp_path)
    await project.add_context_dir(ctx)

    record = FSRecord.load(project.get_type(), project.id)
    meta = record.meta_dict()
    assert any("folder-" in str(t) for t in (meta.get("private_context_entities_") or []))
    assert ctx in json.dumps(meta.get("private_context_entity_data") or {})

    # Re-adopt from the record (the DB-rebuild path).
    rehydrated = await Project.from_record(record, notify=False)
    assert rehydrated.include_dirs == [ctx]


@pytest.mark.asyncio
async def test_worker_add_dir_chain(tmp_path):
    """Computed include_dirs → _project_context_dirs → resolved_add_dirs → --add-dir."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeCliOptions

    project = await _make_project(tmp_path)
    ctx = _ctx_dir(tmp_path)
    await project.add_context_dir(ctx)

    reloaded = await Project.get_by_id(project.id)
    assert reloaded.include_dirs == [ctx]

    worker = AgenticProcess(workdir=str(tmp_path), project_id=project.id)
    # The spawn prelude stamps the cache exactly like get_project() does.
    object.__setattr__(worker, "_project_context_dirs", list(reloaded.include_dirs))
    assert ctx in worker.resolved_add_dirs

    cmd = ClaudeCliOptions(
        session_id="00000000-0000-4000-8000-000000000042",
        resume=False,
        workdir=str(tmp_path),
        add_dirs=worker.resolved_add_dirs,
    ).to_shell_string()
    assert "--add-dir" in cmd
    assert ctx in cmd
