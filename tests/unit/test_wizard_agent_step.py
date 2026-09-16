"""An agentic step reports what the AGENT returned, not that it stopped.

Before this, a `process` step was `completed` because the worker reached a
terminal state. An agent that installed nothing and stopped cheerfully passed;
an agent that knew it had failed had no way to say so. The receipt is the
channel it was missing, and these are its rules.

Everything here is seam-injected — `run_wizard(launch=...)` — so a whole verdict
matrix runs with no process anywhere, in milliseconds.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from flow_sdk.core.wizard import run_wizard
from flow_sdk.core.wizard.exec import ShellResult
from flow_sdk.core.wizard.process_step import ProcessProgress, ProcessResult
from flow_sdk.core.wizard.runner import COMPLETED, FAILED
from flow_sdk.core.wizard.step_result import RESULT_VALUE_CAP, receipt_path
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


def _spec(*, output: str = "release", verify: bool = False) -> WizardSpec:
    step: dict = {
        "id": "ask-agent", "label": "Ask the agent",
        "process": {"agent": "capability-installer", "prompt": "do the thing", **({"output": output} if output else {})},
    }
    if verify:
        step["verify"] = {"commands": {"darwin": "test -f done", "linux": "test -f done"}}
    return WizardSpec.model_validate({"name": "agentic", "steps": [step]})


def _writer(payload: dict | None, *, seen: list | None = None):
    """A launch double that writes the receipt its prompt asked for."""
    async def launch(*, workdir: Path, prompt: str = "", **_kw) -> ProcessResult:
        if seen is not None:
            seen.append(prompt)
        if payload is not None:
            path = receipt_path(workdir, "ask-agent")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(payload), encoding="utf-8")
        return ProcessResult("proc-1", True, "agent finished")

    return launch


async def _ok_shell(_command, **_kw):
    return ShellResult(returncode=0)


def _run(tmp_path, spec, launch, shell=_ok_shell, path: str = ""):
    return asyncio.run(run_wizard(
        spec, subject_entity=None, activity_path=path or f"wizard-agent-{tmp_path.name}",
        trusted=True, workdir=Path(tmp_path), shell=shell, launch=launch, platform="linux",
    ))


def test_the_agents_own_summary_becomes_the_steps_one_line(tmp_path):
    """"agent finished" told a person nothing. Its own sentence tells them
    what happened."""
    result = _run(tmp_path, _spec(), _writer(
        {"status": "done", "summary": "installed Python 3.12.4 via Homebrew", "data": {"release": "3.12.4"}}
    ))
    outcome = result.outcomes[0]
    assert outcome.status == COMPLETED
    assert outcome.message == "installed Python 3.12.4 via Homebrew"
    assert outcome.value == "3.12.4"
    assert outcome.output == "release"
    assert result.outputs == {"release": "3.12.4"}


def test_an_agent_that_reports_failure_fails_the_step(tmp_path):
    """The whole point: honouring only the agent's successes and ignoring its
    failures would be the same bug wearing a smile."""
    result = _run(tmp_path, _spec(), _writer(
        {"status": "error", "summary": "no package manager", "error": "brew is not installed"}
    ))
    outcome = result.outcomes[0]
    assert outcome.status == FAILED
    assert "brew is not installed" in outcome.message
    assert result.status == FAILED
    assert result.outputs == {}


def test_a_missing_receipt_is_a_failed_step_not_an_empty_one(tmp_path):
    """A worker that stops without saying anything has NOT done the work. This
    is the case that used to pass silently."""
    result = _run(tmp_path, _spec(), _writer(None))
    outcome = result.outcomes[0]
    assert outcome.status == FAILED
    assert "wrote no result" in outcome.message


def test_a_stale_receipt_cannot_pass_a_step_that_did_nothing(tmp_path):
    """The nastiest bug this design can have: last run's success, reported for
    a run that produced nothing. The receipt is cleared before the launch."""
    stale = receipt_path(Path(tmp_path), "ask-agent")
    stale.parent.mkdir(parents=True, exist_ok=True)
    stale.write_text(json.dumps({"status": "done", "summary": "from LAST time", "data": {"release": "old"}}))

    result = _run(tmp_path, _spec(), _writer(None))
    assert result.outcomes[0].status == FAILED
    assert "from LAST time" not in result.outcomes[0].message


def test_a_step_declaring_no_output_behaves_exactly_as_before(tmp_path):
    """The compat pin. A step with no `output` never had a contract, so there
    is nothing for it to fail — and every shipped wizard is in this case."""
    result = _run(tmp_path, _spec(output=""), _writer(None))
    outcome = result.outcomes[0]
    assert outcome.status == COMPLETED
    assert outcome.message == "agent finished"
    assert outcome.output == ""


def test_the_result_contract_is_added_only_when_an_output_is_declared(tmp_path):
    """A contract in every prompt would make every existing agentic step start
    failing for want of a file nobody told its author about."""
    declared: list[str] = []
    _run(tmp_path, _spec(), _writer({"status": "done", "data": {"release": "1"}}, seen=declared))
    assert "## Your result" in declared[0]
    assert "release" in declared[0]

    silent: list[str] = []
    _run(tmp_path, _spec(output=""), _writer(None, seen=silent))
    assert "## Your result" not in silent[0]


def test_verify_still_outranks_the_agents_claim(tmp_path):
    """The receipt is the agent's claim; verify is the machine's evidence."""
    async def failing_verify(_command, **_kw):
        return ShellResult(returncode=1)

    result = _run(
        tmp_path, _spec(verify=True),
        _writer({"status": "done", "summary": "all good", "data": {"release": "1"}}),
        shell=failing_verify,
    )
    outcome = result.outcomes[0]
    assert outcome.status == FAILED
    assert "did not take effect" in outcome.message


def test_a_value_over_the_cap_is_refused_with_an_instruction(tmp_path):
    """A returned value becomes an environment variable and rides the run
    record. Past the cap it is an artifact, and the agent is told to say where
    it put it."""
    result = _run(tmp_path, _spec(), _writer(
        {"status": "done", "data": {"release": "x" * (RESULT_VALUE_CAP + 10)}}
    ))
    outcome = result.outcomes[0]
    assert outcome.status == FAILED
    assert "cap" in outcome.message and "return a path" in outcome.message


def test_a_later_step_sees_the_returned_value_in_its_environment(tmp_path):
    """One namespace with the answers a person gave: a step author should not
    have to know whether a value came from a human or an agent."""
    seen_env: dict = {}

    async def capture(command, **kw):
        seen_env.update(kw.get("extra_env") or {})
        return ShellResult(returncode=0)

    spec = WizardSpec.model_validate({"name": "chained", "steps": [
        {"id": "ask-agent", "process": {"agent": "a", "prompt": "p", "output": "release"}},
        {"id": "use-it", "command": {"commands": {"linux": "echo $FLOWPAD_WIZARD_INPUT_RELEASE"}}},
    ]})
    result = _run(tmp_path, spec, _writer({"status": "done", "data": {"release": "v9"}}), shell=capture)

    assert result.status == COMPLETED
    assert seen_env.get("FLOWPAD_WIZARD_INPUT_RELEASE") == "v9"


def test_the_step_row_ticks_while_the_agent_works(tmp_path):
    """Without this the row sits frozen for the whole timeout — half an hour by
    default — and a person cannot tell a working agent from a hung one."""
    from flow_sdk.activity.activity import Activity

    path = f"wizard-ticks-{tmp_path.name}"
    # Read DURING the run: the child is terminal by the time the run returns,
    # and a terminal node keeps its last state but the assertion is about what
    # a watcher would have seen mid-flight.
    seen: list = []

    async def launch(*, on_status=None, **_kw) -> ProcessResult:
        assert on_status is not None, "the runner must offer a status channel"
        on_status(ProcessProgress("working · src/foo.py", counters={"messages": 3}))
        child = next(
            (c for c in Activity.get(path).spec().children if c.name == "ask-agent"), None
        )
        seen.append(child)
        return ProcessResult("proc-1", True, "agent finished")

    _run(tmp_path, _spec(output=""), launch, path=path)

    child = seen[0]
    assert child is not None, "the step's activity child should exist while it runs"
    assert child.current == "working · src/foo.py"
    assert child.counters.get("messages") == 3
