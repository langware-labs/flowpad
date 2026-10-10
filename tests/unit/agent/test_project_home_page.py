"""A project's home page — ``home_page`` in ``project_manifest.json``.

What is under test is the policy: which asset the manifest may name (this
project's own, never another's), how it resolves (``open_home_page`` and its
``home-page`` action), and that the new key never costs the ledger anything
(absent when unset; a bad value degrades, it does not fail the manifest). What an
agent home page OPENS (its last chat, else a new one) is the frontend's —
``ui/tests/unit/project-home-page-redirect.test.ts``.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.assets import project_manifest as manifest
from flow_sdk.responses.response import ApiSuccessResponse
from flow_sdk.schema.data_spec.project_manifest_spec import ProjectManifestSpec
from tests.unit.agent._seed import checkout_agent
from tests.unit.agent._seed import seed_agent as _agent
from tests.unit.agent._seed import seed_project as _project

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

PUBLISHED = {"typeid": f"skill-{uuid.uuid4()}", "rel_path": "agentic-assets/skill/greet", "name": "greet"}


def _declare(root: Path, home_page, *, entries=()) -> None:
    """Hand-write the manifest, the way it arrives in a cloned repo."""
    path = manifest.manifest_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    document = {"schema": 1, "requires": {}, "entries": list(entries), "home_page": home_page}
    path.write_text(json.dumps(document), encoding="utf-8")


# ── the manifest: the key costs the ledger nothing ──────────────────────────


def test_an_unset_home_page_is_not_written():
    """An older desk reads the ledger with ``extra="forbid"``: a key it does not
    know fails its whole manifest, so no manifest gains one it did not ask for."""
    assert "home_page" not in ProjectManifestSpec.empty().to_document()


@pytest.mark.parametrize("bad", ["my-agent", "agent-not-a-uuid", "", 42])
def test_a_malformed_home_page_degrades_without_failing_the_ledger(bad):
    spec = ProjectManifestSpec.model_validate({"schema": 1, "entries": [PUBLISHED], "home_page": bad})

    assert spec.home_page is None
    assert [e.typeid for e in spec.entries] == [PUBLISHED["typeid"]]


def test_set_and_clear_round_trip_and_keep_the_published_rows(tmp_path):
    manifest.publish(tmp_path, manifest.make_entry(**PUBLISHED))
    typeid = f"agent-{uuid.uuid4()}"

    manifest.set_home_page(tmp_path, typeid)
    assert manifest.read_home_page(tmp_path) == typeid
    assert manifest.read_manifest(tmp_path).find(PUBLISHED["typeid"]) is not None

    manifest.set_home_page(tmp_path, None)
    assert manifest.read_home_page(tmp_path) is None
    assert "home_page" not in json.loads(manifest.manifest_path(tmp_path).read_text(encoding="utf-8"))


def test_clearing_never_creates_a_manifest(tmp_path):
    manifest.set_home_page(tmp_path, None)
    assert not manifest.manifest_path(tmp_path).exists()


def test_a_malformed_id_is_refused_at_write_time(tmp_path):
    with pytest.raises(manifest.ManifestError):
        manifest.set_home_page(tmp_path, "my-agent")
    assert not manifest.manifest_path(tmp_path).exists()


# ── the Project: declared, resolved, and set ────────────────────────────────


async def test_no_manifest_is_the_default_home(tmp_path):
    project = await _project(tmp_path / "none")

    assert await project.open_home_page() == {"asset": None, "type": None}


async def test_the_declared_agent_resolves_to_its_asset(tmp_path):
    root = tmp_path / "declared"
    project = await _project(root)
    agent = await _agent(root, "intake")
    _declare(root, str(agent.typeid))

    assert await project.open_home_page() == {"asset": str(agent.typeid), "type": "agent"}


async def test_the_home_page_action_answers_with_the_resolution(tmp_path):
    root = tmp_path / "action"
    project = await _project(root)
    agent = await _agent(root, "intake")
    _declare(root, str(agent.typeid))

    response = await project.home_page_action()

    assert isinstance(response, ApiSuccessResponse)
    assert response.data == {"asset": str(agent.typeid), "type": "agent"}


async def test_the_home_page_is_not_customization(tmp_path):
    root = tmp_path / "not-customization"
    project = await _project(root)
    _declare(root, f"agent-{uuid.uuid4()}")

    assert "home_page" not in project.customization


async def test_an_agent_from_another_project_is_refused(tmp_path):
    other = tmp_path / "vendor"
    await _project(other)
    foreign = await _agent(other, "vendor-agent")
    root = tmp_path / "customer"
    project = await _project(root)
    _declare(root, str(foreign.typeid))

    assert (await project.open_home_page())["asset"] is None


async def test_a_vanished_asset_falls_back_to_the_default_home(tmp_path):
    root = tmp_path / "vanished"
    project = await _project(root)
    _declare(root, f"agent-{uuid.uuid4()}")

    assert (await project.open_home_page())["asset"] is None


async def test_the_set_action_writes_the_manifest_and_refuses_a_foreign_asset(tmp_path):
    other = tmp_path / "vendor"
    await _project(other)
    foreign = await _agent(other, "vendor-agent")
    root = tmp_path / "owner"
    project = await _project(root)
    agent = await _agent(root, "intake")

    ok = await project.set_home_page_action(typeid=str(agent.typeid))
    assert isinstance(ok, ApiSuccessResponse) and ok.data == {"home_page": str(agent.typeid)}
    assert manifest.read_home_page(root) == str(agent.typeid)

    refused = await project.set_home_page_action(typeid=str(foreign.typeid))
    assert not isinstance(refused, ApiSuccessResponse)
    assert manifest.read_home_page(root) == str(agent.typeid), "a refused set must not touch the manifest"

    cleared = await project.set_home_page_action(typeid="")
    assert isinstance(cleared, ApiSuccessResponse) and cleared.data == {"home_page": None}


async def test_the_set_action_updates_the_indexed_manifest_row(tmp_path):
    """The UI reads the home page off the indexed ``ProjectManifest`` row, not the
    file: a set that only wrote the file left the picker showing the default home."""
    from flow_sdk.builtin.project_manifest import ProjectManifest

    root = tmp_path / "owner"
    project = await _project(root)
    agent = await _agent(root, "intake")

    await project.set_home_page_action(typeid=str(agent.typeid))
    row = await ProjectManifest.get_one({"project_id": str(project.id)})
    assert row is not None and row.home_page == str(agent.typeid)

    await project.set_home_page_action(typeid="")
    row = await ProjectManifest.get_one({"project_id": str(project.id)})
    assert row.home_page is None


# ── first open: the home page is indexed before it is looked up ─────────────


async def test_a_never_indexed_home_page_agent_resolves_on_the_first_open(tmp_path):
    root = tmp_path / "fresh"
    project = await _project(root)
    typeid = checkout_agent(root, "greeter")
    _declare(root, typeid)

    assert await project.open_home_page() == {"asset": typeid, "type": "agent"}


# ── a web app home: the project opens app-first ────────────────────────────


async def _web_app(root: Path, name: str, **manifest):
    """A webapp asset folder in the project (``webapp.json`` + a page), indexed; its row."""
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — enrolls MICRO_APP
    from flow_sdk.core import Entity
    from flow_sdk.fs_store.reindex import reindex_paths

    folder = root / "agentic-assets" / "webapp" / name
    folder.mkdir(parents=True)
    (folder / "webapp.json").write_text(json.dumps({"name": name, **manifest}), encoding="utf-8")
    (folder / "index.html").write_text("<h1>app first</h1>", encoding="utf-8")
    await reindex_paths([str(folder)])
    app = await Entity.get_by_asset_ref(str(folder), resolve_containing=True, strict=True)
    assert app is not None and app.get_type() == "micro_app"
    return app


async def test_a_web_app_is_a_home_page_and_resolves_to_itself(tmp_path):
    root = tmp_path / "app-first"
    project = await _project(root)
    app = await _web_app(root, "console")

    answer = await project.set_home_page_action(typeid=str(app.typeid))

    assert isinstance(answer, ApiSuccessResponse) and answer.data == {"home_page": str(app.typeid)}
    assert await project.open_home_page() == {"asset": str(app.typeid), "type": "micro_app", "load_run": None}


async def test_a_web_app_home_with_no_endpoint_here_is_placed_when_it_opens(tmp_path):
    """The app view the redirect lands on shows only this machine's endpoints: one missing (an app indexed before
    its project existed, a wiped row) is placed by the open, as ``flow show`` places it."""
    from flow_sdk.builtin.webapp_placement import webapp_endpoints

    root = tmp_path / "unplaced"
    project = await _project(root)
    app = await _web_app(root, "console")
    for endpoint in await webapp_endpoints(app.id):
        await endpoint.delete()
    _declare(root, str(app.typeid))

    assert await project.open_home_page() == {"asset": str(app.typeid), "type": "micro_app", "load_run": None}
    assert [e.backend.type for e in await webapp_endpoints(app.id)] == ["static"]


async def test_another_projects_web_app_is_never_a_home_page(tmp_path):
    mine = await _project(tmp_path / "mine")
    theirs = tmp_path / "theirs"
    await _project(theirs)
    app = await _web_app(theirs, "their-console")

    refused = await mine.set_home_page_action(typeid=str(app.typeid))
    _declare(Path(mine.fs_storage_mount_path), str(app.typeid))

    assert not isinstance(refused, ApiSuccessResponse)
    assert await mine.open_home_page() == {"asset": None, "type": None}


# ── a web app home is LOADED: up by the time its view mounts ────────────────


async def test_opening_a_static_home_app_stamps_it_loaded(tmp_path):
    """Files Flowpad serves itself are up as soon as they are placed: the first open stamps the row and starts
    nothing; the next open is one probe."""
    from flow_sdk.builtin.faas.micro_app import WebApp

    root = tmp_path / "static-home"
    project = await _project(root)
    app = await _web_app(root, "console")
    _declare(root, str(app.typeid))

    assert (await project.open_home_page())["load_run"] is None
    row = await WebApp.get_by_id(app.id)
    assert row.setup_loaded is not None and row.setup_loaded.run == "" and row.setup_loaded.detail == "already up"


async def test_opening_a_home_app_whose_dev_server_is_down_starts_its_load_and_answers_at_once(tmp_path, monkeypatch):
    """An app that declares a dev server and has no build is not up until that server answers: the open starts
    the app's own node of the setup tree in its load phase and answers its address — the view adopts that run
    as the app's setup. The open never waits on it."""
    from flow_sdk.builtin import project_setup
    from flow_sdk.builtin.faas.micro_app import WebApp

    started = []

    async def start(project, *, root, phase, on_done=None, **_kw):
        started.append((root, phase))
        return f"setup-{root}"

    monkeypatch.setattr(project_setup, "start_setup", start)
    root = tmp_path / "dev-home"
    project = await _project(root)
    app = await _web_app(root, "console", endpoints=[{
        "name": "web", "serving": {"type": "proxy", "start_cmd": "npx vite --port {port}", "health": "/"},
    }])
    _declare(root, str(app.typeid))

    answer = await project.open_home_page()

    assert answer == {"asset": str(app.typeid), "type": "micro_app", "load_run": f"setup-{app.typeid}"}
    assert started == [(str(app.typeid), "load")]
    assert (await WebApp.get_by_id(app.id)).setup_loaded is None, "stamped only once the run reaches its goal"
