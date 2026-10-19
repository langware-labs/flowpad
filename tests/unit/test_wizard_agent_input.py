"""An agent op hands the spawned process a typed input and a launch context, from scope.

Real runner, real step launch (``launch_step_process``), the worker doubled by the mock
driver. What the worker sees in its input folder is the proof; the process row carries the
context chips and the context data the launch context named.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.core.compute_op.runner import run_op
from flow_sdk.schema.data_spec.compute_op_spec import AgentOp, ComputeOpSpec, LaunchContext, OpSubkind
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, PromptResult
from flow_sdk.schema.data_spec.spec import DataSpec

pytestmark = [pytest.mark.timeout(10), pytest.mark.usefixtures("tmp_records_root", "home")]  # do not increase timeout without approval


class Note(DataSpec):
    text: str
    sender: str = ""


async def _agent(name: str = "note-reader"):
    from flow_sdk.builtin.agent import Agent

    for other in await Agent.get_all({"name": name}):
        await other.delete()
    agent = Agent(name=name, system_prompt="You read notes.")
    await agent.save()
    return agent


def _spec(**exe) -> ComputeOpSpec:
    return ComputeOpSpec(name="read-note", subkind=OpSubkind.AGENT, exe_data=AgentOp(agent="note-reader", prompt="Read it.", **exe))


async def test_the_worker_finds_the_value_in_its_input_folder(initialize_test_db, mock_driver, tmp_path: Path):
    seen: dict = {}

    def behavior(turn):
        files = turn.listdir(turn.input_dir)
        seen["files"] = files
        seen["body"] = "".join(turn.read(turn.input_dir / name) for name in files)
        return "Read."

    driver = mock_driver(behavior)
    await _agent()
    answer = await run_op(_spec(input="DOC"), trusted=True, workdir=tmp_path,
                          values={"DOC": Note(text="charged twice", sender="Dana")})
    assert isinstance(answer, PromptResult) and answer.ok, answer.detail
    assert driver.received_prompts and answer.executor
    assert seen["files"], "the input folder was mounted"
    assert "charged twice" in seen["body"]


async def test_the_launch_context_lands_on_the_process(initialize_test_db, mock_driver, tmp_path: Path):
    mock_driver(lambda turn: "Done.")
    await _agent()
    chip = "flow_message-11111111-1111-4111-8111-111111111111"
    context = LaunchContext(context_data={"automation": {"reason": "asks for a refund"}},
                            shared_context_entities=[chip], target_typeid_str="conversation-22222222-2222-4222-8222-222222222222")
    answer = await run_op(_spec(input="DOC", launch_context="CTX"), trusted=True, workdir=tmp_path,
                          values={"DOC": Note(text="x"), "CTX": context})
    assert answer.ok, answer.detail
    process = await AgenticProcess.get_by_typeid(answer.executor)
    assert process.context_data["automation"] == {"reason": "asks for a refund"}
    assert process.context_data["compute_op"] == "read-note"
    assert chip in [str(t) for t in process.shared_context_entities]  # the launch may add chips of its own
    assert process.target_typeid_str == context.target_typeid_str


async def test_a_missing_or_untyped_input_is_an_answer_not_a_launch(initialize_test_db, mock_driver, tmp_path: Path):
    driver = mock_driver(lambda turn: "never")
    await _agent()
    missing = await run_op(_spec(input="DOC"), trusted=True, workdir=tmp_path, values={})
    assert missing.exit_code is ExitCode.NOT_APPLICABLE and "nothing named 'DOC'" in missing.detail
    untyped = await run_op(_spec(input="DOC"), trusted=True, workdir=tmp_path, values={"DOC": json.dumps({"a": 1})})
    assert untyped.exit_code is ExitCode.NOT_APPLICABLE and "not a value an agent can be given" in untyped.detail
    assert driver.received_prompts == [], "nothing was spawned"
