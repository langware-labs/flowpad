"""A call on a message (``process_call_spec``) and its run (``core/compute/process_call``)."""

import json
import re
from pathlib import Path

import pytest

from flow_sdk.core.compute import process_call as runner
from flow_sdk.schema.data_spec.compute_op_spec import CliOp
from flow_sdk.schema.data_spec.process_call_spec import (
    ProcessCall,
    answer_attachment,
    call_attachment,
    process_call_in,
)
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, PromptResult, ReturnedValue


def _receipt_path(prompt: str) -> Path:
    return Path(re.search(r"exactly this path:\s+(\S+)", prompt).group(1))


def _fake_launch(receipt, calls):
    async def launch(**kwargs):
        calls.append(kwargs)
        if receipt is not None:
            _receipt_path(kwargs["prompt"]).write_text(json.dumps(receipt))
        return PromptResult.satisfied("ran", text="the agent's whole reply", executor="agentic_process-x")

    return launch


@pytest.fixture
def call():
    return runner.prompt_call("pull latest and switch to feature/x")


def test_call_round_trips_through_its_attachment(call):
    att = call_attachment(call)
    assert att["data"] == f"process_call-{call.call_id}"
    assert process_call_in([att]) == call
    assert process_call_in([{**att, "prompt_preview": "not json"}]) is None


def test_call_reads_off_a_message_model(call):
    from flow_sdk.builtin.flow_message import Attachment

    assert process_call_in([Attachment(**call_attachment(call))]) == call


def test_status_answer_carries_no_output(call):
    answer = PromptResult.satisfied("On feature/x.", text="secret output", executor="agentic_process-x", reported=True)
    att = answer_attachment(call, answer)
    assert att["data"] == f"returned_value-{call.call_id}"
    sent = ReturnedValue.model_validate(json.loads(att["prompt_preview"]))
    assert (sent.exit_code, sent.detail, sent.reported) == (ExitCode.OK, "On feature/x.", True)
    assert sent.executor is None and sent.value is None
    assert "secret output" not in att["prompt_preview"]


async def test_good(monkeypatch, call, tmp_path):
    calls = []
    receipt = {"status": "done", "summary": "On feature/x.", "data": {runner.OUTCOME_KEY: "On feature/x, 6 commits pulled."}}
    monkeypatch.setattr(runner, "launch_step_process", _fake_launch(receipt, calls))
    answer = await runner.run_process_call(call, workdir=tmp_path)
    assert answer.exit_code is ExitCode.OK and answer.reported
    assert answer.detail == "On feature/x, 6 commits pulled."
    # The sender's prompt is never kept on the process row, and the receipt never lands in the project.
    assert calls[0]["remember_prompt"] is False
    assert "feature/x" not in calls[0]["name"]
    assert not any(tmp_path.rglob("result.json"))


async def test_bad_is_the_agents_own_reason(monkeypatch, call, tmp_path):
    receipt = {"status": "error", "summary": "Local changes to src/app.ts would be overwritten.", "error": "checkout"}
    monkeypatch.setattr(runner, "launch_step_process", _fake_launch(receipt, []))
    answer = await runner.run_process_call(call, workdir=tmp_path)
    assert (answer.exit_code, answer.reported) == (ExitCode.NOT_YET, True)
    assert answer.detail == "Local changes to src/app.ts would be overwritten."


async def test_missing_result_is_an_error(monkeypatch, call, tmp_path):
    monkeypatch.setattr(runner, "launch_step_process", _fake_launch(None, []))
    answer = await runner.run_process_call(call, workdir=tmp_path)
    assert (answer.exit_code, answer.reported) == (ExitCode.NOT_YET, False)
    assert answer.detail == runner.MISSING_RESULT


async def test_a_run_that_breaks_is_an_error(monkeypatch, call, tmp_path):
    async def launch(**_):
        return PromptResult.not_yet("The agent did not finish within 60s.", timed_out=True)

    monkeypatch.setattr(runner, "launch_step_process", launch)
    answer = await runner.run_process_call(call, workdir=tmp_path)
    assert (answer.exit_code, answer.reported) == (ExitCode.NOT_YET, False)
    assert "did not finish" in answer.detail


async def test_only_agent_calls_run(tmp_path):
    call = ProcessCall(call_id="c", exe=CliOp(commands={"darwin": "ls"}))
    answer = await runner.run_process_call(call, workdir=tmp_path)
    assert answer.exit_code is ExitCode.NOT_APPLICABLE and not answer.ran


def test_declined_never_ran():
    answer = runner.declined()
    assert answer.exit_code is ExitCode.REFUSED and not answer.ran
    assert isinstance(answer, ReturnedValue)
