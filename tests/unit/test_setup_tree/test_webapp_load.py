"""Real presentation records: the load check detects what repair must persist."""
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.faas.micro_app import WebApp
from flow_sdk.builtin.webapp_load import present
from flow_sdk.builtin.webapp_placement import webapp_endpoints
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode
from tests.unit.agent._seed import seed_project


async def seed(tmp_path):
    project = await seed_project(tmp_path / "project")
    app = WebApp(name="example", project_id=project.id,
                 asset_ref=str(tmp_path / "project/agentic-assets/webapp/example"))
    await app.save()
    entry = Path(app.asset_ref) / "index.html"
    entry.write_text("<html><body>Example</body></html>")
    process = AgenticProcess(project_id=project.id, pty_mode=False)
    await process.save()
    return app, process, entry


@pytest.mark.parametrize("address", ["native", "local", "project"])
async def test_present_checks_then_repairs_saved_html_display(tmp_path, address):
    app, process, entry = await seed(tmp_path)
    path = str(entry)
    if address == "local":
        from flow_sdk.api.api_types.vfs_path import VFSPath
        from flow_sdk.fs_store.type_id import TypeId
        path = VFSPath.from_machine_path(path, TypeId("compute_node-@local")).uri
    elif address == "project":
        path = f"vfs://project-{app.project_id}/agentic-assets/webapp/example/index.html"
    raw = {"kind": "vfs", "path": path}
    await process.on_show(raw)
    before = (await AgenticProcess.get_by_id(process.id)).context_data
    check = await present(app, display=str(process.typeid), check=True)
    assert check.exit_code is ExitCode.NOT_YET and str(process.typeid) in check.detail
    assert (await AgenticProcess.get_by_id(process.id)).context_data == before
    assert (await present(app, display=str(process.typeid), check=False)).ok
    repaired = (await AgenticProcess.get_by_id(process.id)).context_data
    assert repaired["last_shown"]["typeid"] == str(app.typeid)
    assert repaired["last_shown"]["kind"] == "app"
    assert (await present(app, display=str(process.typeid), check=True)).ok
    assert (await present(app, display=str(process.typeid), check=False)).ok
    assert (await AgenticProcess.get_by_id(process.id)).context_data == repaired


async def test_missing_entry_never_reports_ready_or_rewrites_display(tmp_path):
    app, process, entry = await seed(tmp_path)
    await process.on_show({"kind": "vfs", "path": str(entry)})
    entry.unlink()
    before = (await AgenticProcess.get_by_id(process.id)).context_data
    result = await present(app, display=str(process.typeid), check=False)
    assert result.exit_code is ExitCode.NOT_YET and "missing web.app entry" in result.detail
    assert (await AgenticProcess.get_by_id(process.id)).context_data == before


async def test_unrelated_display_is_preserved_while_missing_placement_recovers(tmp_path):
    app, process, entry = await seed(tmp_path)
    unrelated = {"kind": "vfs", "path": str(entry.with_name("report.html"))}
    await process.on_show(unrelated)
    for endpoint in await webapp_endpoints(app.id):
        await endpoint.delete()
    assert not (await present(app, display=str(process.typeid), check=True)).ok
    assert (await present(app, display=str(process.typeid), check=False)).ok
    assert (await AgenticProcess.get_by_id(process.id)).context_data["last_shown"] == unrelated


async def test_default_project_load_recovers_and_detects_restored_failure(tmp_path):
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.project_setup import _RUNS
    from flow_sdk.core.setup.load import load_project, load_state
    from flow_sdk.schema.data_spec.asset_setup_spec import LoadState

    app, process, entry = await seed(tmp_path)
    project = await Project.get_by_id(app.project_id)
    raw = {"kind": "vfs", "path": str(entry)}
    for _ in range(2):
        await process.on_show(raw)
        result = await load_project(project, display=str(process.typeid))
        assert result.state is LoadState.RUNNING, result.detail
        assert result.display == str(process.typeid)
        assert (await _RUNS[(str(project.id), "")]).ok
        assert load_state(str(project.id)).state is LoadState.READY
        assert load_state(str(project.id)).display == str(process.typeid)
        shown = (await AgenticProcess.get_by_id(process.id)).context_data["last_shown"]
        assert shown["kind"] == "app" and shown["typeid"] == str(app.typeid)


async def test_unscoped_load_does_not_attest_to_or_replace_display_recovery(tmp_path):
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.project_setup import _RUNS
    from flow_sdk.core.setup.load import load_project, load_state
    from flow_sdk.schema.data_spec.asset_setup_spec import LoadState

    app, process, entry = await seed(tmp_path)
    project = await Project.get_by_id(app.project_id)
    raw = {"kind": "vfs", "path": str(entry)}
    await process.on_show(raw)
    result = await load_project(project)
    assert result.state is LoadState.RUNNING and result.display is None
    assert (await _RUNS[(str(project.id), "")]).ok
    assert load_state(str(project.id)).display is None
    assert (await AgenticProcess.get_by_id(process.id)).context_data["last_shown"] == raw
    scoped = await load_project(project, display=str(process.typeid))
    assert scoped.state is LoadState.RUNNING and scoped.display == str(process.typeid)
    assert (await _RUNS[(str(project.id), "")]).ok
    assert load_state(str(project.id)).display == str(process.typeid)
    assert (await AgenticProcess.get_by_id(process.id)).context_data["last_shown"]["typeid"] == str(app.typeid)


async def test_api_only_app_does_not_require_html_presentation(tmp_path):
    from flow_sdk.schema.data_spec.webapp_spec import WebappEndpointSpec

    app, process, entry = await seed(tmp_path)
    app.endpoints = [WebappEndpointSpec.model_validate({"name": "api", "protocol": {"spec_kind": "api.rest"},
                                                     "serving": {"type": "static"}})]
    await app.save()
    entry.unlink()
    assert (await present(app, display=str(process.typeid), check=True)).ok


async def test_outdated_endpoint_uses_matching_presentation(tmp_path):
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.webapp_placement import local_web_deployment, place_webapp_locally, upsert_endpoint
    from flow_sdk.core.display_target import endpoint_target

    app, process, entry = await seed(tmp_path)
    project = await Project.get_by_id(app.project_id)
    valid = await place_webapp_locally(app)
    deployment = await local_web_deployment(project)
    outdated, _ = await upsert_endpoint(deployment, name="obsolete", webapp_id=app.id, project_id=app.project_id,
                                       backend={"type": "static", "root": str(entry.parent)})
    await process.on_show(endpoint_target(outdated))
    assert not (await present(app, display=str(process.typeid), check=True)).ok
    assert (await present(app, display=str(process.typeid), check=False)).ok
    assert (await AgenticProcess.get_by_id(process.id)).context_data["last_shown"]["endpoint_id"] == valid.id


async def test_a_viewer_is_presented_by_its_module_not_an_index_page(tmp_path):
    app, _process, entry = await seed(tmp_path)
    entry.unlink()
    app.kind = "application.web.viewer"
    missing = await present(app, check=True)
    assert missing.exit_code is ExitCode.NOT_YET and "missing viewer module" in missing.detail
    (Path(app.asset_ref) / "viewer.js").write_text("export default {}")
    assert (await present(app, check=True)).ok
