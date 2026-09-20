"""The agent rung reports what the AGENT returned, not that it stopped.

A spawned harness used to be "done" because the worker reached a terminal state.
An agent that installed nothing and stopped cheerfully passed; an agent that knew
it had failed had no way to say so. The receipt is the channel it was missing,
and these are its rules — now the rung's rules rather than a wizard step's,
because an agent run IS a ComputeOp.

Everything here is seam-injected (`run_op(launch=…)`), so the whole verdict
matrix runs with no process anywhere, in milliseconds.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from flow_sdk.core.compute.exec import ShellResult
from flow_sdk.core.compute.process_step import ProcessProgress, ProcessResult
from flow_sdk.core.compute.receipt import RESULT_VALUE_CAP, receipt_path
from flow_sdk.core.compute_op import run_op
from flow_sdk.core.compute_op.runner import VALUE_KEY
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

OP_NAME = "ask-agent"


def _op(*, output: object = "string", check: bool = False) -> ComputeOpSpec:
    body: dict = {
        "name": OP_NAME,
        "attempts": [{"kind": "agent", "agent": "capability-installer", "prompt": "do the thing"}],
    }
    if output:
        body["output"] = output
    if check:
        body["completion_check"] = {"commands": {"darwin": "test -f done", "linux": "test -f done"}}
    return ComputeOpSpec.model_validate(body)


def _writer(payload: "dict | None", *, seen: "list | None" = None):
    """A launch double that writes the receipt its prompt asked for."""
    async def launch(*, workdir: Path, prompt: str = "", **_kw) -> ProcessResult:
        if seen is not None:
            seen.append(prompt)
        if payload is not None:
            path = receipt_path(workdir, OP_NAME)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(payload), encoding="utf-8")
        return ProcessResult(process_id="proc-1", ok=True, message="agent finished")

    return launch


async def _ok_shell(_command, **_kw):
    return ShellResult(returncode=0)


def _run_op(tmp_path, spec, launch, shell=_ok_shell):
    return asyncio.run(run_op(
        spec, trusted=True, workdir=Path(tmp_path), platform="linux",
        shell=shell, launch=launch,
    ))


def test_the_agents_own_summary_becomes_the_one_line(tmp_path):
    """"agent finished" told a person nothing. Its own sentence tells them what
    happened."""
    answer = _run_op(tmp_path, _op(), _writer(
        {"status": "done", "summary": "installed Python 3.12.4 via Homebrew",
         "data": {VALUE_KEY: "3.12.4"}}
    ))
    assert answer.ok
    assert answer.detail == "installed Python 3.12.4 via Homebrew"
    assert answer.value == "3.12.4"


def test_an_agent_that_reports_failure_fails_the_rung(tmp_path):
    """Honouring only the agent's successes and ignoring its failures would be
    the same bug wearing a smile."""
    answer = _run_op(tmp_path, _op(), _writer(
        {"status": "error", "summary": "no package manager", "error": "brew is not installed"}
    ))
    assert not answer.ok


def test_a_missing_receipt_is_a_failure_not_an_empty_success(tmp_path):
    """A worker that stops without saying anything has NOT done the work. This
    is the case that used to pass silently."""
    answer = _run_op(tmp_path, _op(), _writer(None))
    assert not answer.ok


def test_a_stale_receipt_cannot_pass_a_rung_that_did_nothing(tmp_path):
    """The nastiest bug this design can have: last run's success reported for a
    run that produced nothing. The receipt is cleared before the launch."""
    stale = receipt_path(Path(tmp_path), OP_NAME)
    stale.parent.mkdir(parents=True, exist_ok=True)
    stale.write_text(json.dumps(
        {"status": "done", "summary": "from LAST time", "data": {VALUE_KEY: "old"}}
    ))

    answer = _run_op(tmp_path, _op(), _writer(None))
    assert not answer.ok
    assert "from LAST time" not in answer.detail
    assert answer.value is None


def test_an_op_declaring_no_output_asks_for_no_receipt(tmp_path):
    """An op with no declared shape never had a contract, so there is nothing
    for it to fail — and that is every goal-shaped op."""
    answer = _run_op(tmp_path, _op(output=None), _writer(None))
    assert answer.ok
    assert answer.detail == "agent finished"
    assert answer.value is None


def test_the_result_contract_is_added_only_when_an_output_is_declared(tmp_path):
    """A contract in every prompt would make every existing agentic op start
    failing for want of a file nobody told its author about."""
    declared: list[str] = []
    _run_op(tmp_path, _op(), _writer({"status": "done", "data": {VALUE_KEY: "1"}}, seen=declared))
    assert "## Your result" in declared[0]

    silent: list[str] = []
    _run_op(tmp_path, _op(output=None), _writer(None, seen=silent))
    assert "## Your result" not in silent[0]


def test_the_check_still_outranks_the_agents_claim(tmp_path):
    """The receipt is the agent's claim; the check is the machine's evidence."""
    async def failing_check(_command, **_kw):
        return ShellResult(returncode=1)

    answer = _run_op(
        tmp_path, _op(check=True),
        _writer({"status": "done", "summary": "all good", "data": {VALUE_KEY: "1"}}),
        shell=failing_check,
    )
    assert not answer.ok, "the agent said it worked; the machine says otherwise"


def test_a_value_over_the_cap_is_refused_with_an_instruction(tmp_path):
    """A returned value rides the run record and can become an environment
    variable. Past the cap it is an artifact, and the agent is told to say where
    it put it."""
    answer = _run_op(tmp_path, _op(), _writer(
        {"status": "done", "data": {VALUE_KEY: "x" * (RESULT_VALUE_CAP + 10)}}
    ))
    assert not answer.ok


def test_a_declared_shape_is_enforced_on_the_way_out(tmp_path):
    """The first place in this repo where a declared `SpecType` means anything.

    A value that does not match is a FAILURE, not a warning: a caller binding it
    into a later step would carry the breakage somewhere it cannot be explained.
    """
    typed = _op(output={"port": "int"})

    good = _run_op(tmp_path, typed, _writer({"status": "done", "data": {VALUE_KEY: {"port": 8099}}}))
    assert good.ok and good.value.port == 8099

    bad = _run_op(tmp_path, typed, _writer({"status": "done", "data": {VALUE_KEY: {"port": "nope"}}}))
    assert not bad.ok
    assert "declared output" in bad.detail


def test_the_rung_ticks_while_the_agent_works(tmp_path):
    """Without this the row sits frozen for the whole timeout — half an hour by
    default — and a person cannot tell a working agent from a hung one."""
    seen: list[str] = []

    async def launch(*, on_status=None, **_kw) -> ProcessResult:
        assert on_status is not None, "the runner must offer a status channel"
        on_status(ProcessProgress(text="working · src/foo.py", counters={"messages": 3}))
        return ProcessResult(process_id="proc-1", ok=True, message="agent finished")

    asyncio.run(run_op(
        _op(output=None), trusted=True, workdir=Path(tmp_path), platform="linux",
        shell=_ok_shell, launch=launch, on_status=seen.append,
    ))
    assert "working · src/foo.py" in seen
