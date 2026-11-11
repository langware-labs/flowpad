"""A project's needs come from what is INSTALLED in it, never from the catalog.

Roots are the installed assets — a data source, an agent, a dependency, a credential the project authored
itself. A driver or a shipped template is the catalog: it says how to ask, never that something is needed.
A need is derived from its roots on every read, so it never outlives them, and "Skip → Always" uninstalls
the roots (staged in git), taking the credentials they installed along.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from flow_sdk.builtin import project_setup
from flow_sdk.builtin.credential_service import declare_oauth, save_credential

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

GITHUB_PAT = {"name": "github-pat", "setup": "Make a token.", "vars": {"GITHUB_TOKEN": {}}}


def _commit_all(root: Path) -> None:
    subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(root), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init",
                    "--allow-empty"], check=True)


def _staged(root: Path) -> str:
    return subprocess.run(["git", "-C", str(root), "diff", "--cached", "--name-status"], capture_output=True,
                          text=True, check=True).stdout


async def _gmail_source(project):
    """An installed Gmail source in the project's folder, the way flowpad-oss has one."""
    from flow_sdk.builtin.data_source import DataSource

    source = DataSource(name="Gmail", provider="gmail", project_id=str(project.id), config={})
    await source.save()
    folder = Path(project.fs_storage_mount_path) / "agentic-assets" / "data_source" / "gmail"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "data_source.json").write_text('{"name": "gmail", "data_driver_name": "gmail"}')
    source.asset_ref = str(folder)
    await source.save()
    return source


def _only(monkeypatch, *sources):
    async def of_project(_project):
        return list(sources)

    monkeypatch.setattr(project_setup, "project_sources", of_project)


def _no_running(monkeypatch):
    async def nothing(_project, *_a, **_k):
        return []

    monkeypatch.setattr(project_setup, "_running_here", nothing)


async def _snapshot(project) -> tuple[list[str], int]:
    from flow_sdk.builtin.credential import Credential

    root = Path(project.fs_storage_mount_path)
    return sorted(str(p.relative_to(root)) for p in root.rglob("*") if ".git" not in p.parts), len(await Credential.get_all())


async def test_a_source_using_a_template_is_its_need_and_always_uninstalls_it(project, templates, monkeypatch):
    from flow_sdk.builtin.data_source import DataSource

    import shutil

    from flow_sdk.builtin import data_source

    source = await _gmail_source(project)
    _only(monkeypatch, source)
    _no_running(monkeypatch)
    _commit_all(Path(project.fs_storage_mount_path))
    # This test's tmp folder sits under the instance's own home, which the deleter protects; a real project does not.
    monkeypatch.setattr(data_source, "remove_source_folder", lambda ref: shutil.rmtree(ref))

    (gmail,) = [r for r in await project_setup.collect_requirements(project) if r.name == "gmail"]
    assert not gmail.declared and [(r.kind, r.name) for r in gmail.roots] == [("data_source", "Gmail")]
    assert gmail.can_skip_always, gmail.why_not_always

    await project_setup.skip_requirement(project, gmail.typeid, scope="always")

    assert await DataSource.get_by_id(str(source.id)) is None
    assert not (Path(source.asset_ref) / "data_source.json").exists()
    staged = _staged(Path(project.fs_storage_mount_path))
    assert "D\tagentic-assets/data_source/gmail/data_source.json" in staged, staged
    _only(monkeypatch)  # the index no longer has it
    assert "gmail" not in [r.name for r in (await project_setup.readiness_of(project)).to_do]


async def test_a_driver_or_template_alone_needs_nothing(project, templates, monkeypatch):
    _only(monkeypatch)
    assert await project_setup.collect_requirements(project) == []


async def test_a_derived_credential_stops_being_needed_with_its_source(project, catalogue, monkeypatch):
    from flow_sdk.builtin.data_source import DataSource

    catalogue("google")
    source = DataSource(name="drive", provider="gdrive", project_id=str(project.id), read_only=True, config={})
    await source.save()  # its create declares the connection, installed by the source
    from flow_sdk.builtin.credential import Credential

    google = await Credential.get("google", project)
    assert google.derived, "a root installed it"

    _only(monkeypatch, source)
    assert "google" in [r.name for r in await project_setup.collect_requirements(project)]
    await DataSource.delete_by_id(str(source.id))
    _only(monkeypatch)
    assert "google" not in [r.name for r in await project_setup.collect_requirements(project)]


async def test_a_credential_the_project_authored_is_its_own_root(project, templates, monkeypatch):
    from flow_sdk.builtin.credential import Credential

    _only(monkeypatch)
    _no_running(monkeypatch)
    spec = await save_credential(manifest=GITHUB_PAT, scope="project", project_id=project.id)
    _commit_all(Path(project.fs_storage_mount_path))

    (pat,) = await project_setup.collect_requirements(project)
    assert [(r.kind, r.name) for r in pat.roots] == [("credential", "github-pat")] and pat.can_skip_always

    await project_setup.skip_requirement(project, pat.typeid, scope="always")
    assert await Credential.get_by_id(str(spec.id)) is None
    assert "credential.json" in _staged(Path(project.fs_storage_mount_path))


async def test_always_takes_the_credentials_a_root_installed(project, catalogue, monkeypatch):
    from flow_sdk.builtin.credential import Credential

    catalogue("google")
    source = await _gmail_source(project)
    spec, _ = await declare_oauth(project, "google", ["s"])
    _only(monkeypatch, source)
    _no_running(monkeypatch)
    _commit_all(Path(project.fs_storage_mount_path))

    gmail_only = await Credential.get_by_id(str(spec.id))
    assert gmail_only.derived
    await project_setup._uninstall(project, [project_setup._root(source, project_setup.ROOT_SOURCE)])
    _only(monkeypatch)
    await project_setup._drop_orphans(project)
    assert await Credential.get_by_id(str(spec.id)) is None, "derived, and no root needs it now: gone"


async def test_a_root_outside_the_project_is_refused_with_a_reason(project, templates, monkeypatch, tmp_path):
    from flow_sdk.builtin.data_source import DataSource

    elsewhere = tmp_path / "elsewhere" / "gmail"
    elsewhere.mkdir(parents=True)
    source = DataSource(name="Gmail", provider="gmail", config={}, asset_ref=str(elsewhere))
    _only(monkeypatch, source)
    _no_running(monkeypatch)

    (gmail,) = [r for r in await project_setup.collect_requirements(project) if r.name == "gmail"]
    assert not gmail.can_skip_always and "outside the project folder" in gmail.why_not_always
    with pytest.raises(project_setup.SkipRefused, match="outside the project folder"):
        await project_setup.skip_requirement(project, gmail.typeid, scope="always")
    assert elsewhere.exists()


async def test_collecting_writes_nothing(project, catalogue, monkeypatch):
    from flow_sdk.builtin.data_source import DataSource

    catalogue("google", "gmail")
    _only(monkeypatch, DataSource(name="drive", provider="gdrive", read_only=True, config={}),
          DataSource(name="Gmail", provider="gmail", config={}))
    before = await _snapshot(project)
    reqs = await project_setup.collect_requirements(project)
    assert {r.name for r in reqs} >= {"google", "gmail"}
    assert await _snapshot(project) == before


async def test_a_held_connection_short_of_scopes_is_widened_by_the_setup_step_not_by_collect(project, catalogue,
                                                                                            monkeypatch):
    from flow_sdk.builtin.credential import Credential
    from flow_sdk.builtin.data_source import DataSource

    catalogue("google")
    source = DataSource(name="drive", provider="gdrive", project_id=str(project.id), read_only=True, config={})
    await declare_oauth(project, "google", [])  # declared before it needed Drive
    _only(monkeypatch, source)

    (google,) = [r for r in await project_setup.collect_requirements(project) if r.name == "google"]
    assert google.declared and google.satisfied is False and "drive.readonly" in google.note
    assert "drive.readonly" not in " ".join((await Credential.get("google", project)).scopes), "collect wrote nothing"

    scopes = ",".join(google.scopes)
    assert (await project_setup.requirement_step(str(project.id), f"credential:google:{project.id}:{scopes}", check=True))[0] is False
    assert (await project_setup.requirement_step(str(project.id), f"credential:google:{project.id}:{scopes}", check=False))[0]
    assert set(google.scopes) <= set((await Credential.get("google", project)).scopes)


async def test_readiness_lists_what_is_set_up_and_each_step_names_its_node(project, templates, monkeypatch):
    """The setup page lists Ready steps (``set_up``) beside what is left, and runs one step by its ``node``."""
    from flow_sdk.schema.data_spec.project_setup_spec import REQUIREMENT_WEBAPP, SetupRequirementSpec

    _only(monkeypatch)
    await save_credential(manifest=GITHUB_PAT, scope="project", project_id=project.id)
    app = SetupRequirementSpec(kind=REQUIREMENT_WEBAPP, name="Demo App", satisfied=True, used_by=["project"],
                               typeid="micro_app-11111111-1111-4111-8111-111111111111")
    asked = {}

    async def running(_project, *_a, include_ready=False):
        asked["include_ready"] = include_ready
        return [app]

    monkeypatch.setattr(project_setup, "_running_here", running)
    readiness = await project_setup.readiness_of(project, include_ready=True)

    assert asked == {"include_ready": True}
    assert [r.name for r in readiness.set_up] == ["Demo App"]
    assert readiness.set_up[0].node == app.typeid  # a web app's node is its own typeid
    assert all(r.node for r in readiness.to_do)
    # The footer's poll asks for neither.
    plain = await project_setup.readiness_of(project)
    assert asked == {"include_ready": False} and plain.set_up == [] and not any(r.node for r in plain.to_do)
