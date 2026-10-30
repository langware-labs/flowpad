"""`flow app serve` on a folder that IS a webapp asset serves the asset, not a bare artifact.

A bare artifact has no webapp id, so when its address goes away (a backend restart) the display has
nothing to set up and shows a dead end. The asset gets the setup gate, its load and its recovery.
"""
import json
from pathlib import Path

from flow_sdk.builtin.faas.micro_app import WebApp
from flow_sdk.builtin.webapp_placement import webapp_asset_at, webapp_routes
from tests.unit.agent._seed import seed_project


def write_app(folder: Path) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "webapp.json").write_text(json.dumps({"name": folder.name, "title": "Demo", "build": "."}))
    (folder / "index.html").write_text("<html><body>Demo</body></html>")
    return folder


async def test_an_unindexed_webapp_folder_is_indexed_as_its_projects_asset(tmp_path):
    project = await seed_project(tmp_path / "project")
    folder = write_app(tmp_path / "project/agentic-assets/webapp/demo")

    app = await webapp_asset_at(folder)

    assert isinstance(app, WebApp)
    assert app.project_id == project.id
    assert Path(app.asset_ref).resolve() == folder.resolve()
    # Indexing places it: the static route that serves the folder exists, keyed by the asset.
    assert [p.backend.type for p in await webapp_routes(app.id)] == ["static"]


async def test_the_same_folder_resolves_to_the_same_asset(tmp_path):
    await seed_project(tmp_path / "project")
    folder = write_app(tmp_path / "project/agentic-assets/webapp/demo")

    first = await webapp_asset_at(folder)
    second = await webapp_asset_at(folder)

    assert first is not None and second is not None and first.id == second.id


async def test_a_folder_without_webapp_json_is_not_an_asset(tmp_path):
    await seed_project(tmp_path / "project")
    folder = tmp_path / "project/site"
    folder.mkdir(parents=True)
    (folder / "index.html").write_text("<html></html>")

    assert await webapp_asset_at(folder) is None


async def test_serving_the_asset_shows_it_by_its_typeid(tmp_path):
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    project = await seed_project(tmp_path / "project")
    folder = write_app(tmp_path / "project/agentic-assets/webapp/demo")
    app = await webapp_asset_at(folder)
    process = AgenticProcess(project_id=project.id, pty_mode=False)
    await process.save()

    answer = (await process._serve_webapp_asset(app, show=True)).data

    assert answer["artifact"] is None and answer["webapp"]["id"] == app.id
    static = [e for e in answer["endpoints"] if e["backend"]["type"] == "static"]
    assert static and static[0]["webapp_id"] == app.id
    shown = (await AgenticProcess.get_by_id(process.id)).context_data["last_shown"]
    assert shown["typeid"] == str(app.typeid)
