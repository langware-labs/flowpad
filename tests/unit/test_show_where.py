"""`flow show` never switches the person's view, so its answer says where the target went."""

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.faas.micro_app import WebApp
from flow_sdk.core.display_target import resolve_display_target
from flow_sdk.core.navigate import show_target
from tests.unit.agent._seed import seed_project

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def _app_and_process(tmp_path, same_project: bool):
    session_project = await seed_project(tmp_path / "session")
    app_project = session_project if same_project else await seed_project(tmp_path / "mocks")
    app = WebApp(name="mock", project_id=app_project.id, asset_ref=str(tmp_path / "mocks/agentic-assets/webapp/mock"))
    await app.save()
    process = AgenticProcess(project_id=session_project.id, pty_mode=False)
    await process.save()
    return app, process


async def test_an_app_from_another_project_opens_beside_the_session(tmp_path):
    """The tab is presented in the session's project (``presentedIn``), so no other project is named."""
    app, process = await _app_and_process(tmp_path, same_project=False)
    answer = await show_target(await resolve_display_target(typeid=str(app.typeid)), process=process)
    assert answer.delivered
    assert str(app.project_id) not in answer.detail and "not switched" in answer.detail


async def test_a_folder_shown_by_path_says_it_is_a_folder(tmp_path):
    """Shown as a file it opened empty with its PARENT listed beside it (Nir, 2026-11-17)."""
    folder = tmp_path / "Langware legal"
    folder.mkdir()
    (folder / "terms.docx").write_text("x")
    shown = await resolve_display_target(path=str(folder))
    assert shown["kind"] == "vfs" and shown["is_dir"] is True
    assert "is_dir" not in await resolve_display_target(path=str(folder / "terms.docx"))
