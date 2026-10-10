"""A resolved dependency as a project's context link — the cache every reader uses.

Contract under test (no LLM, no server):

  * ``add_dependency`` on a folder mints the Folder entity and links it into the
    project's PRIVATE bucket with a sidecar naming the dependency; the computed
    ``include_dirs`` / ``context_dir_infos`` derive from it.
  * ``remove_dependency`` unlinks it, and never deletes the Folder entity or
    touches disk.
  * Privacy: links are a per-machine cache — no local path and no folder link
    appears in ``_hub_body`` or the ``share()`` body; ``flow.json`` is what travels.
  * Indexing: a git dependency is indexed READ-ONLY (somebody else's checkout),
    a ``file:`` folder writably.
  * Durability: the links + sidecars round-trip the record's metadata.json
    (ProjectMeta), so they survive a DB rebuild.
  * Worker chain: the computed list flows through ``_project_context_dirs``
    stamping into ``resolved_add_dirs`` and the rendered ``--add-dir`` flags.

# do not increase timeout without approval
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from flow_sdk.builtin import project_dependencies
from flow_sdk.builtin.folder import Folder
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.schema.type_info import register_all
from tests.unit._project_names import unique_project_name

register_all()

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", *args],
        cwd=cwd, check=True, capture_output=True, text=True, timeout=20,
    )


def _checkout(tmp_path: Path, name: str = "repo") -> Path:
    """A user's own clone of a ``file://`` remote — a folder inside git."""
    remote = tmp_path / f"{name}-remote"
    remote.mkdir()
    (remote / "README.md").write_text("# r\n", encoding="utf-8")
    _git(remote, "init", "-q", "-b", "main")
    _git(remote, "add", "-A")
    _git(remote, "commit", "-qm", "seed")
    mine = tmp_path / name
    _git(tmp_path, "clone", "-q", f"file://{remote}", str(mine))
    return mine


async def _make_project(tmp_path: Path, name: str = "ctx-proj") -> Project:
    (tmp_path / name).mkdir(exist_ok=True)
    project = Project(name=unique_project_name(name), fs_storage_mount_path=str(tmp_path / name))
    await project.save()
    return project


def _ctx_dir(tmp_path: Path, name: str = "extra") -> str:
    d = tmp_path / name
    d.mkdir(exist_ok=True)
    return canonical_posix_path(str(d))


@pytest.fixture(autouse=True)
def workspace(tmp_path, monkeypatch):
    """Clones land in this test's own workspace."""
    ws = tmp_path / "workspace"
    ws.mkdir()
    monkeypatch.setattr("flow_sdk.fs_store.origin.git_origin._workspace", lambda: ws)
    project_dependencies._DISMISSED.clear()
    return ws


async def test_a_folder_dependency_is_a_private_link_with_its_sidecar(tmp_path):
    project = await _make_project(tmp_path)
    ctx = _ctx_dir(tmp_path)

    resp = await project.add_dependency_action(source=ctx)
    assert resp.status == "SUCCESS"

    # Folder entity minted, deterministic id.
    folder = await Folder.get_by_id(Folder.id_for_path(ctx))
    assert folder is not None and folder.path == ctx

    # Linked privately (a per-machine cache) with the sidecar naming the dependency.
    assert [str(t) for t in project.context_of_type("folder", bucket="private")] == [str(folder.typeid)]
    assert project.context_of_type("folder", bucket="shared") == []
    assert project.get_context_entry_data(folder.typeid) == {
        "path": ctx,
        "origin_kind": "local",
        "dependency": "extra",
        "source": f"file:{ctx}",
        "subpath": ".",
        "via": None,
        "own": True,
        "required": True,
        "cloned": False,
        "read_only": False,
    }
    assert project.include_dirs == [ctx]
    # Action response carries the computed lists (frontend adopts them).
    assert resp.data["include_dirs"] == [ctx]
    assert resp.data["dependency"]["state"] == "ready"

    # Idempotent re-add.
    await project.add_dependency(ctx)
    assert project.include_dirs == [ctx]
    assert len(project.context_of_type("folder", bucket="both")) == 1


async def test_context_dir_infos_carries_origin_kind_and_dependency(tmp_path):
    """context_dir_infos mirrors include_dirs with the stamped origin_kind ('git'
    for a folder inside git, 'local' otherwise) and the dependency it stands for."""
    project = await _make_project(tmp_path)
    local = _ctx_dir(tmp_path)
    repo = canonical_posix_path(str(_checkout(tmp_path)))

    await project.add_dependency(local)
    await project.add_dependency(repo)

    infos = {i["path"]: i for i in project.context_dir_infos}
    assert infos[local]["origin_kind"] == "local"
    assert infos[repo]["origin_kind"] == "git"
    assert (infos[repo]["dependency"], infos[repo]["required"], infos[repo]["via"]) == ("repo-remote", True, "")
    assert [i["path"] for i in project.context_dir_infos] == project.include_dirs
    assert {i["typeid"] for i in project.context_dir_infos} == {
        str(t) for t in project.context_of_type("folder", bucket="both")
    }

    # A sidecar without the origin_kind stamp defaults to 'local'.
    from flow_sdk.fs_store.type_id import TypeId

    project.add_private_context_entities(TypeId(infos[local]["typeid"]), data={"path": local})
    assert next(i for i in project.context_dir_infos if i["path"] == local)["origin_kind"] == "local"


async def test_removing_a_dependency_unlinks_it(tmp_path):
    project = await _make_project(tmp_path)
    ctx = _ctx_dir(tmp_path)
    (tmp_path / "extra" / "keep.txt").write_text("data")

    state = await project.add_dependency(ctx)
    assert project.include_dirs == [ctx]

    await project.remove_dependency(state.name)
    assert project.include_dirs == []
    assert project.context_of_type("folder", bucket="both") == []
    folder_id = Folder.id_for_path(ctx)
    assert project.get_context_entry_data((await Folder.get_by_id(folder_id)).typeid) is None
    assert "dependencies" not in json.loads((tmp_path / "ctx-proj" / "flow.json").read_text())

    # Folder entity survives (other projects may link it); disk untouched.
    assert await Folder.get_by_id(folder_id) is not None
    assert (tmp_path / "extra" / "keep.txt").exists()

    # Removing a name that is not declared is fine.
    assert await project.remove_dependency("nothing-here") == []
    resp = await project.remove_dependency_action(name="nothing-here")
    assert resp.status == "SUCCESS"


async def test_context_paths_and_links_never_on_the_wire(tmp_path, monkeypatch):
    """Neither a local folder's path nor a git folder's local checkout path — nor
    either link — appears in the hub row. The links are a per-machine cache;
    what a member gets is the project's flow.json, which travels with the repo."""
    project = await _make_project(tmp_path)
    local = _ctx_dir(tmp_path, "private-secret")
    repo = canonical_posix_path(str(_checkout(tmp_path)))
    await project.add_dependency(local)
    await project.add_dependency(repo)
    tids = [str(t) for t in project.context_of_type("folder", bucket="both")]
    assert len(tids) == 2

    body = project._hub_body()
    payload = json.dumps(body, default=str)
    for computed in ("include_dirs", "context_roots", "context_dir_infos"):
        assert computed not in body
    assert local not in payload and repo not in payload
    for tid in tids:
        assert tid not in payload

    posts = []

    class _Creds:
        api_key = "token"

    class _Client:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        # Mirrors the real ``FlowpadClient.post``, which takes ``idempotent``.
        # A non-None return means the create succeeded, so ``share`` takes the
        # ordinary path and makes no ownership probe.
        async def post(self, path, body, *, idempotent: bool = False, **_kwargs):
            posts.append((path, body))
            return {"ok": True}

    monkeypatch.setattr("flow_sdk.cli.auth.credentials.load_credentials", lambda: _Creds())
    monkeypatch.setattr("flow_sdk.cloud_client.client.ApiConfig.from_env", staticmethod(lambda: object()))
    monkeypatch.setattr("flow_sdk.cloud_client.client.FlowpadClient", _Client)

    await project.share()

    shared = json.dumps(posts[0][1], default=str)
    assert local not in shared and repo not in shared
    assert "shared_context_origins" not in posts[0][1]
    for tid in tids:
        assert tid not in shared
    # The one thing a member will be missing is said, not hidden.
    assert project.last_share_result.warnings == [
        f"private-secret: file:{local} is a folder on this machine; members will not have it"
    ]


async def test_a_git_dependency_is_indexed_read_only_and_a_folder_writably(tmp_path, monkeypatch):
    """read_only for a git checkout because it is somebody else's repository:
    indexing would otherwise commit capsule ids into the working tree and the
    next `git pull` would abort on "local changes would be overwritten". A
    ``file:`` folder is the user's own, so its assets may mint ids."""
    import flow_sdk.builtin.agentic_process.agentic_process as agentic_process

    project = await _make_project(tmp_path)
    local = _ctx_dir(tmp_path)
    repo = canonical_posix_path(str(_checkout(tmp_path)))
    indexed = []

    async def _index(path, **kwargs):
        indexed.append((path, kwargs.get("read_only"), kwargs.get("project_id")))

    monkeypatch.setattr(agentic_process, "_index_additional_dir", _index)

    await project.add_dependency(local)
    await project.add_dependency(repo)

    # Neither folder is a project's mount, so the depending project owns what is found.
    assert indexed == [(local, False, str(project.id)), (repo, True, str(project.id))]

    indexed.clear()
    await project.resolve_dependencies()
    assert indexed == [], "an unchanged link is not re-indexed"


async def test_links_roundtrip_record_metadata(tmp_path):
    """ProjectMeta persistence: links + sidecars survive disk→DB re-adopt."""
    project = await _make_project(tmp_path)
    ctx = _ctx_dir(tmp_path)
    await project.add_dependency(ctx)

    record = FSRecord.load(project.get_type(), project.id)
    meta = record.meta_dict()
    assert any("folder-" in str(t) for t in (meta.get("private_context_entities_") or []))
    assert ctx in json.dumps(meta.get("private_context_entity_data") or {})
    assert not meta.get("include_dirs"), "the computed list is never stored"

    # Re-adopt from the record (the DB-rebuild path).
    rehydrated = await Project.from_record(record, notify=False)
    assert rehydrated.include_dirs == [ctx]


async def test_model_dump_feedback_is_harmless(tmp_path):
    """``Project(**model_dump())`` feeds the computed ``include_dirs`` back in as a
    raw key; it must neither fail nor invent a second link."""
    project = await _make_project(tmp_path)
    ctx = _ctx_dir(tmp_path)
    await project.add_dependency(ctx)

    dump = project.model_dump(mode="json")
    assert dump["include_dirs"] == [ctx]
    clone = Project(**dump)
    assert clone.include_dirs == [ctx]
    await clone.save()
    assert len(clone.context_of_type("folder", bucket="both")) == 1
    assert clone.include_dirs == [ctx]


async def test_worker_add_dir_chain(tmp_path):
    """Computed include_dirs → _project_context_dirs → resolved_add_dirs → --add-dir."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions

    project = await _make_project(tmp_path)
    ctx = _ctx_dir(tmp_path)
    await project.add_dependency(ctx)

    reloaded = await Project.get_by_id(project.id)
    assert reloaded.include_dirs == [ctx]

    worker = AgenticProcess(workdir=str(tmp_path), project_id=project.id)
    # The spawn prelude stamps the cache exactly like get_project() does.
    object.__setattr__(worker, "_project_context_dirs", list(reloaded.include_dirs))
    assert ctx in worker.resolved_add_dirs

    cmd = ClaudeAgentOptions(
        session_id="00000000-0000-4000-8000-000000000042",
        resume=False,
        workdir=str(tmp_path),
        add_dirs=worker.resolved_add_dirs,
    ).to_shell_string()
    assert "--add-dir" in cmd
    assert ctx in cmd
