"""`flow show` never switches the person's view, so its answer says where the target went."""
import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.faas.micro_app import WebApp
from flow_sdk.core.display_target import resolve_display_target
from flow_sdk.core.navigate import show_target
from tests.unit.agent._seed import seed_project

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _no_fixer_agent(monkeypatch):
    """The mock app has no files, so bringing it up fails and recovery would hand it to the
    webapp-fixer AGENT -- a real LLM run on any host with a signed-in worker. Where the tab goes is
    the question here, so the fixer answers as on a box with no assistant: it could not run."""
    from flow_sdk.core.webapp import coordinator

    async def _absent(key, request):
        raise RuntimeError("no fixer in this test")

    monkeypatch.setattr(coordinator, "_run_fixer", _absent)


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
