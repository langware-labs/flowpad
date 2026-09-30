"""FLOWPAD-2180 — the auto prompt belongs to SESSIONS opened as an agent
(``Agent.use``), never to one-shot runs: a run brings its own prompt, and
queueing the auto prompt behind it would give the run a second turn.

Real agent, real local deployment, real ``Deployment.launch`` →
``create_process``. The only stub is ``take_turn`` — the worker spawn — so no
agent actually runs; the process it would have run is captured instead.
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin.agentic_process import process_io
from flow_sdk.schema.data_spec.returned_value_spec import PromptResult
from tests.unit.agent._seed import seed_agent, seed_project


@pytest.fixture
def turns(monkeypatch):
    """Capture every (process, prompt) a run hands to the worker, without spawning it."""
    taken: list[tuple[object, str]] = []

    async def _take_turn(process, prompt, output_spec, *, wait=True):
        taken.append((process, prompt))
        return PromptResult.satisfied("accepted", executor=str(process.typeid))

    monkeypatch.setattr(process_io, "take_turn", _take_turn)
    return taken


async def test_a_run_sends_only_its_own_prompt_and_queues_nothing(tmp_path, turns):
    project = await seed_project(tmp_path / "proj")
    agent = await seed_agent(
        tmp_path / "proj", "greeter", auto_launch=True, auto_launch_prompt="Say hello", project_id=project.id
    )

    answer = await agent.launch("summarise the inbox")

    assert answer.ok, answer.detail
    [(process, prompt)] = turns
    assert prompt == "summarise the inbox"
    assert process.queue.read()["entries"] == []
