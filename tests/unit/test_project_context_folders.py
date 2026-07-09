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
from flow_sdk.builtin.git_origin import GitOrigin
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


def _git_origin_for(canonical: str) -> GitOrigin:
    """A deterministic GitOrigin for a path's leaf — the transportable origin a
    real git-backed folder would carry (its id == origin.key())."""
    leaf = canonical.rstrip("/").rsplit("/", 1)[-1] or "root"
    return GitOrigin(provider="github", owner="acme", name="repo", branch="main", rel_path=leaf)


@pytest.fixture
def stub_git_detect(monkeypatch):
    """Make ``Folder.detect_origin`` classify any path as git-backed, so
    shared-scope adds are exercisable without a real repo. Returns a resolver
    from canonical path → the folder id that will be minted (origin.key())."""
    async def _detect(path):
        return _git_origin_for(canonical_posix_path(path))

    monkeypatch.setattr(Folder, "detect_origin", staticmethod(_detect))
    return lambda canonical: Folder.id_for_origin(_git_origin_for(canonical))


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
async def test_local_folder_blocked_from_shared_scope(tmp_path):
    """A plain (non-git) folder is non-transportable → rejected from shared."""
    project = await _make_project(tmp_path)
    ctx = _ctx_dir(tmp_path, "shared-extra")

    resp = await project.add_context_dir(ctx, scope="shared")
    assert resp.status == "FAIL"
    assert project.context_of_type("folder", bucket="shared") == []

    bad = await project.add_context_dir(ctx, scope="bogus")
    assert bad.status == "FAIL"


@pytest.mark.asyncio
async def test_git_folder_allowed_in_shared_scope(tmp_path, stub_git_detect):
    """A git-backed folder IS transportable → allowed in shared; its id is
    origin.key() and it derives include_dirs from the local sidecar path."""
    project = await _make_project(tmp_path)
    ctx = _ctx_dir(tmp_path, "shared-repo")

    resp = await project.add_context_dir(ctx, scope="shared")
    assert resp.status == "SUCCESS"
    tids = project.context_of_type("folder", bucket="shared")
    assert [str(t) for t in tids] == [f"folder-{stub_git_detect(ctx)}"]
    assert project.context_of_type("folder", bucket="private") == []
    assert project.include_dirs == [ctx]


@pytest.mark.asyncio
async def test_remove_context_dir_unlinks(tmp_path):
    project = await _make_project(tmp_path)
    ctx = _ctx_dir(tmp_path)
    (tmp_path / "extra" / "keep.txt").write_text("data")

    await project.add_context_dir(ctx)  # local → private
    assert project.include_dirs == [ctx]

    await project.remove_context_dir(ctx)
    assert project.include_dirs == []
    assert project.context_of_type("folder", bucket="both") == []
    # Sidecar pruned.
    folder_id = Folder.id_for_path(ctx)
    assert project.get_context_entry_data((await Folder.get_by_id(folder_id)).typeid) is None

    # Folder entity survives (other projects may link it); disk untouched.
    assert await Folder.get_by_id(folder_id) is not None
    assert (tmp_path / "extra" / "keep.txt").exists()

    # No-op remove is fine.
    resp = await project.remove_context_dir(ctx)
    assert resp.status == "SUCCESS"


@pytest.mark.asyncio
async def test_context_paths_never_on_the_wire(tmp_path, stub_git_detect):
    """Neither a private local folder's path/link nor a shared git folder's
    local sidecar path appear in the hub push body; only the shared LINK travels."""
    project = await _make_project(tmp_path)
    private_dir = _ctx_dir(tmp_path, "private-secret")
    shared_dir = _ctx_dir(tmp_path, "shared-repo")
    # Private add: force a LOCAL origin (bypass the stub) so it stays private-only.
    import flow_sdk.builtin.folder as folder_mod
    from flow_sdk.builtin.local_origin import LocalOrigin
    orig_detect = folder_mod.Folder.detect_origin
    folder_mod.Folder.detect_origin = staticmethod(
        lambda p: _as_coro(LocalOrigin(base=canonical_posix_path(p)))
    )
    try:
        await project.add_context_dir(private_dir)  # local → private
    finally:
        folder_mod.Folder.detect_origin = orig_detect
    await project.add_context_dir(shared_dir, scope="shared")  # git (stub) → shared

    body = project._hub_body()
    payload = json.dumps(body, default=str)
    assert "include_dirs" not in body
    assert private_dir not in payload  # private local path never on the wire
    assert shared_dir not in payload   # shared folder's LOCAL sidecar path is local-only
    # The shared LINK (folder typeid == origin.key()) travels via shared_context_entities.
    shared_tid = f"folder-{stub_git_detect(shared_dir)}"
    assert shared_tid in payload
    private_tid = str((await Folder.get_by_id(Folder.id_for_path(private_dir))).typeid)
    assert private_tid not in payload


async def _as_coro(value):
    return value


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
