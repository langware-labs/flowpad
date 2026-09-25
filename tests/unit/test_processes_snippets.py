"""``docs/snippets/processes.md``, run as written on the mock worker.

§1 gives a process an MCP server and prompts it; §2 gives an agent MCP servers every process inherits;
§3 launches an agent, reads the answer, the artifacts and releases the worker; §4 runs a typed folder
in → typed folder out: the mock's file actions read the input CV and write the reviewed one. The
history-reading fence of §3 needs a real harness's transcript and is pinned by
``tests/long_tests/test_loginless_in_docker.py``.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from tests.utils.snippets import doc, fence_under, run_fence

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(10), pytest.mark.usefixtures("tmp_records_root", "home")]  # do not increase timeout without approval

DOC = "processes.md"


@pytest.fixture
def mock(mock_driver):
    return mock_driver


async def _until(predicate) -> None:
    while not predicate():
        await asyncio.sleep(0.01)


async def test_1_one_process_gets_an_mcp_server(initialize_test_db, mock):
    driver = mock()
    ns = await run_fence(fence_under(doc(DOC), "1."), {}, filename=f"{DOC} §1")
    await asyncio.wait_for(_until(lambda: driver.received_prompts), timeout=5)
    assert driver.received_prompts == ["Open https://example.com and tell me the page title."]
    assert [s.name for s in ns["process"].resolved_mcp_servers()] == ["playwright"]
    await ns["process"].wait()

    await run_fence(fence_under(doc(DOC), "1.", nth=1), ns, filename=f"{DOC} §1b")
    assert ns["process"].resolved_mcp_servers() == ()
    await ns["process"].exit()


async def _researcher():
    from flow_sdk.builtin.agent import Agent

    # The fences look the agent up by name (``get_one``), and the session's test DB holds any
    # "researcher" an earlier test made — exactly one must answer.
    for other in await Agent.get_all({"name": "researcher"}):
        await other.delete()
    agent = Agent(name="researcher", system_prompt="You research; you do not summarize.")
    await agent.save()
    return agent


async def test_2_an_agents_mcp_servers_reach_every_process(initialize_test_db, mock):
    mock()
    await _researcher()
    ns = await run_fence(fence_under(doc(DOC), "2."), {}, filename=f"{DOC} §2")
    assert ns["answer"].ok
    ns = await run_fence(fence_under(doc(DOC), "2.", nth=1), ns, filename=f"{DOC} §2b")
    assert [m.name for m in await ns["agent"].mcp_assets()] == ["linear", "docs"]
    assert [s.name for s in ns["process"].resolved_mcp_servers()] == ["linear", "docs"]


async def test_3_launch_read_the_answer_and_release_the_worker(initialize_test_db, mock):
    from flow_sdk.builtin.agent import Agent

    mock(lambda turn: "Three bullets.")
    await _researcher()
    ns = await run_fence(fence_under(doc(DOC), "3."), {"Agent": Agent}, filename=f"{DOC} §3")
    assert ns["answer"].ok and ns["answer"].text == "Three bullets."
    assert ns["proc"].typeid is not None
    ns = await run_fence(fence_under(doc(DOC), "3.", nth=1), ns, filename=f"{DOC} §3 artifacts")
    assert ns["produced"] == []
    await run_fence(fence_under(doc(DOC), "3.", nth=3), ns, filename=f"{DOC} §3 exit")


async def test_4_a_cv_in_is_a_cv_out(initialize_test_db, mock):
    def review(turn):
        cv = json.loads(turn.read(turn.input_dir / turn.main_document))
        turn.write(turn.output_dir / turn.main_document, json.dumps({**cv, "skills": ["Go", "Postgres"]}))
        turn.write(turn.output_dir / "body.md", "# Dana Levi\n\n" + turn.read(turn.input_dir / "body.md"))
        return "Your CV was reviewed"

    driver = mock(review)
    ns = await run_fence(fence_under(doc(DOC), "4."), {"CV_TEXT": "Backend engineer, 8 years."}, filename=f"{DOC} §4")
    answer = ns["cv_reviewed"]
    assert answer.ok and answer.text == "Your CV was reviewed"
    assert type(answer.value) is ns["CVSpec"] and answer.value.skills == ["Go", "Postgres"]
    assert answer.value.body == "# Dana Levi\n\nBackend engineer, 8 years."
    assert answer.files == ["body.md", "cvspec.json"], "the page's comment names these files"
    assert driver.received_prompts == ["Review and convert the input CV"]
