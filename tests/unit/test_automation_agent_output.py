"""An automation's agent hands back its declared output, kept as a value file a viewer opens.

Real automation entry (``run_then``), real step launch (``launch_step_process``), the worker
doubled by the mock driver. The agent declares ``output`` in its own document; the automation
declares nothing.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.automations.then import AGENT_STEP, run_then
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.process_io import OUTPUT_VALUE_KEY

pytestmark = [pytest.mark.timeout(10), pytest.mark.usefixtures("tmp_records_root", "home")]  # do not increase timeout without approval


def _writes(doc: dict):
    """The worker's turn: leave *doc* as the declared output's document."""
    def turn(t):
        t.write(t.output_dir / t.main_document, json.dumps(doc))
        return "done"
    return turn


async def _reviewer():
    from flow_sdk.builtin.agent import Agent

    for other in await Agent.get_all({"name": "pr-reviewer"}):
        await other.delete()
    agent = Agent(name="pr-reviewer", system_prompt="You review PRs.", output={"verdict": "string", "summary": "string"})
    await agent.save()
    return agent


def _rule(agent_id: str) -> SimpleNamespace:
    return SimpleNamespace(id="", name="review new PRs", parent_type_id="", project_id="", typeid="",
                           then={"run_agent": {"agent": agent_id, "prompt": "Review it."}})


async def test_the_automation_gets_the_agents_value_and_its_file(initialize_test_db, mock_driver):
    mock_driver(_writes({"verdict": "request changes", "summary": "retry can resend"}))
    agent = await _reviewer()

    result = await run_then(_rule(str(agent.id)), inputs={})

    step = result.steps[AGENT_STEP]
    assert step.ok, step.detail
    assert step.value is not None and step.value.verdict == "request changes"
    process = await AgenticProcess.get_by_typeid(step.executor)
    kept = Path(process.context_data[OUTPUT_VALUE_KEY])
    assert kept.name.endswith(".value.json")
    written = json.loads(kept.read_text())
    assert written["spec_kind"]
    assert written["summary"] == "retry can resend"


async def test_an_invalid_output_is_not_yet_and_keeps_no_value(initialize_test_db, mock_driver):
    mock_driver(_writes({"summary": "no verdict"}))
    agent = await _reviewer()

    result = await run_then(_rule(str(agent.id)), inputs={})

    step = result.steps[AGENT_STEP]
    assert not step.ok and "not a valid" in step.detail
    process = await AgenticProcess.get_by_typeid(step.executor)
    assert OUTPUT_VALUE_KEY not in (process.context_data or {})
