"""The ``sample-context-git`` repo, attached as a shared context folder.

The local half of the sample-repo cycle: generate the repository, publish it to a
bare `file://` origin, clone it, attach the clone to a project as a **shared**
context folder, and assert the project's menu reports all 35 assets by type.

This is the gate before the repo is published to GitHub — if a type declared in
the manifest is not actually discovered from a context folder, the count is wrong
here first, and it says which type.

Shared scope is the load-bearing part: it is rejected outright unless the folder
has a transportable origin (``project.py``'s "Only git-backed folders can be
shared"). Passing it proves ``Folder.detect_origin`` read the local `file://`
remote as a real ``GitOrigin`` — the same code path a GitHub remote takes.
"""

from __future__ import annotations

import subprocess
import uuid
from pathlib import Path

import pytest

# Register every walker + TypeInfo. Pytest does not run the server startup path.
import flow_sdk.fs_store.indexer.registrations  # noqa: F401

from flow_sdk.builtin.asset_menu import BrowsingOptions
from flow_sdk.builtin.folder import Folder
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.path_utils import canonical_posix_path
from scripts.make_sample_context_repo import write_repo
from tests.fixtures.sample_context_repo import SAMPLE_CONTEXT_ASSETS, SAMPLE_CONTEXT_TOTAL

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase without approval


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


@pytest.fixture
async def attached(tmp_path: Path, monkeypatch):
    """A project with the generated repo attached as a SHARED context folder."""
    from flow_sdk.instance_settings import reset_instance_settings

    user_home = tmp_path / "user_home"
    user_home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(user_home))
    monkeypatch.setenv("FLOWPAD_INDEX_SCAN_MODE", "thread")
    reset_instance_settings()

    # NOT tmp_path itself — the autouse isolated_records_root puts the records
    # store at tmp_path/records, and walking that would index the shadow store.
    base = tmp_path / "tree"
    base.mkdir(parents=True, exist_ok=True)

    # 1. Generate the repo, then publish it to a bare origin and clone it back —
    #    the clone is what gets attached, exactly as a user would work.
    source = base / "source"
    write_repo(source)
    _git(source, "init", "-q", "-b", "main")
    _git(source, "config", "user.email", "fixture@example.test")
    _git(source, "config", "user.name", "Fixture")
    _git(source, "add", "-A")
    _git(source, "commit", "-qm", "sample context assets")

    origin = base / "sample-context-git.git"
    subprocess.run(["git", "init", "--bare", "-q", str(origin)], check=True, capture_output=True)
    _git(source, "remote", "add", "origin", origin.resolve().as_uri())
    _git(source, "push", "-q", "-u", "origin", "main")

    clone = base / "sample-context-git"
    _git(base, "clone", "-q", origin.resolve().as_uri(), str(clone))

    # 2. A project, and the clone attached to it as a shared context folder.
    root = base / "proj"
    root.mkdir(parents=True, exist_ok=True)
    project = Project(
        id=Project.derive_id_for_path(str(root)),
        name=f"sample-{uuid.uuid4().hex[:6]}",
        fs_storage_mount_path=str(root),
    )
    await project.save()
    # A success response carries no status_code; a failure does. Shared scope is
    # rejected for a non-transportable origin, so reaching here at all is the
    # assertion that the file:// remote was read as a real GitOrigin.
    resp = await project.add_context_dir(str(clone), scope="shared")
    assert getattr(resp, "status_code", 200) < 400, f"shared attach failed: {resp.message}"

    yield {"project": project, "clone": clone, "origin": origin}

    for tid in list(project.context_of_type("folder", bucket="both")):
        try:
            folder = await Folder.get_by_id(tid.id)
            if folder is not None:
                await folder.delete()
        except Exception:
            pass
    try:
        await project.delete()
    except Exception:
        pass
    reset_instance_settings()


async def _menu(project) -> dict:
    resp = await project.get_assets_action(browsing=BrowsingOptions(menu=True, assets=False))
    return resp.data["menu"]


def _groups(node: dict) -> dict[str, int]:
    return {g["type_name"]: g["count"] for g in node["groups"]}


async def test_every_declared_type_is_discovered(attached):
    """Anti-vacuity gate. Names the type that stopped being found rather than
    just reporting a wrong total."""
    root = (await _menu(attached["project"]))["root"]
    ctx = root["children"][0]
    found = _groups(ctx)
    for type_name, expected in SAMPLE_CONTEXT_ASSETS.items():
        assert found.get(type_name, 0) == expected, (
            f"{type_name}: expected {expected} in the sample repo, menu reports {found.get(type_name, 0)}"
        )


async def test_all_35_assets_accumulate_into_the_project(attached):
    """The project's own folder is empty, so its accumulated counts ARE the
    context folder's — the whole point of attaching one."""
    root = (await _menu(attached["project"]))["root"]
    assert _groups(root) == dict(SAMPLE_CONTEXT_ASSETS)
    assert sum(_groups(root).values()) == SAMPLE_CONTEXT_TOTAL == 35
    # Nothing of its own: every asset arrived through the context folder.
    assert all(g["own_count"] == 0 for g in root["groups"])


async def test_the_context_folder_reports_a_git_origin(attached):
    root = (await _menu(attached["project"]))["root"]
    ctx = root["children"][0]
    assert ctx["path"] == canonical_posix_path(attached["clone"])
    assert ctx["origin_kind"] == "git"
    assert ctx["depth"] == 1

    origin = await Folder.detect_origin(canonical_posix_path(attached["clone"]))
    assert origin.kind == "git"
    assert origin.transportable is True
    # The origin round-trips to a clonable URL — what a receiver would use.
    assert origin.clone_url().startswith("file://")


async def test_readme_describes_the_repo(attached):
    readme = (attached["clone"] / "README.md").read_text(encoding="utf-8")
    assert "# sample-context-git" in readme
    assert "context folder" in readme
    assert str(SAMPLE_CONTEXT_TOTAL) in readme
    # The manifest table is rendered from the same declaration the test asserts.
    for type_name in SAMPLE_CONTEXT_ASSETS:
        assert str(SAMPLE_CONTEXT_ASSETS[type_name]) in readme
