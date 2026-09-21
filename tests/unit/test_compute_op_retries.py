"""An agent rung's ``retries`` — a further turn in the SAME process, told what the check said.

Driven through the real runner with a fake shell and a fake launcher, like
``test_compute_op_runner``. The launcher records every call, so each case can
assert WHICH process was prompted and WHAT it was told.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from flow_sdk.core.compute.exec import ShellResult
from flow_sdk.core.compute.process_step import ProcessResult
from flow_sdk.core.compute_op import run_op
from flow_sdk.schema.data_spec.compute_op_spec import AttemptSpec, ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

pytestmark = pytest.mark.timeout(5)

CHECK = "broker answers"


def _spec(*, retries: int = 0, check: bool = True) -> ComputeOpSpec:
    body = {
        "name": "kafka-running",
        "label": "kafka",
        "attempts": [{"kind": "agent", "agent": "provisioner", "prompt": "Reach it.", "retries": retries}],
    }
    if check:
        body["completion_check"] = {"commands": {"linux": CHECK}}
    return ComputeOpSpec.model_validate(body)


def _check_passes_after(n_failures: int):
    """A check that fails ``n_failures`` times — the first ask included — then passes."""
    asked = {"n": 0}

    async def shell(command, **_kw):
        asked["n"] += 1
        if asked["n"] <= n_failures:
            return ShellResult(returncode=1, stdout="", stderr=f"connection refused #{asked['n']}")
        return ShellResult(returncode=0, stdout="ok", stderr="")
    return shell


def _launcher(calls: list, *, ok=True, timed_out=False, process_id="proc-1"):
    async def launch(**kw):
        calls.append(kw)
        return ProcessResult(process_id=process_id, ok=ok, timed_out=timed_out,
                             message="agent finished" if ok else "agent run failed")
    return launch


async def _run(spec, shell, launch, tmp_path, probes=None):
    return await run_op(
        spec, trusted=True, workdir=Path(tmp_path), platform="linux", shell=shell, launch=launch,
        on_probe=(lambda phase, result: probes.append((phase, result))) if probes is not None else None,
    )


@pytest.mark.asyncio
async def test_the_default_is_one_turn_and_no_retry(tmp_path):
    calls: list = []
    verdict = await _run(_spec(), _check_passes_after(99), _launcher(calls), tmp_path)
    assert len(calls) == 1
    assert calls[0]["process_id"] is None
    assert verdict.exit_code is ExitCode.NOT_YET


@pytest.mark.asyncio
async def test_a_retry_prompts_the_same_process_with_what_the_check_said(tmp_path):
    calls: list = []
    # the first ask (before any rung) and the re-check after turn 1 fail; the one after the retry passes
    verdict = await _run(_spec(retries=1), _check_passes_after(2), _launcher(calls), tmp_path)

    assert verdict.ok, verdict.detail
    assert "retry 1" in verdict.detail
    assert len(calls) == 2
    first, retry = calls
    assert first["process_id"] is None
    assert retry["process_id"] == "proc-1"
    # the verdict it could not see, and the bar — not the task restated
    assert f"`{CHECK}` did not reach the goal (exit 1)" in retry["prompt"]
    assert "connection refused #2" in retry["prompt"]
    assert "You are done only when this exits 0" in retry["prompt"]
    assert "Reach it." not in retry["prompt"]


@pytest.mark.asyncio
async def test_retries_stop_at_the_limit_and_the_op_stays_pending(tmp_path):
    calls: list = []
    probes: list = []
    verdict = await _run(_spec(retries=2), _check_passes_after(99), _launcher(calls), tmp_path, probes)
    assert len(calls) == 3
    assert [c.get("process_id") for c in calls] == [None, "proc-1", "proc-1"]
    assert [phase for phase, _ in probes] == ["agent", "agent retry 1", "agent retry 2"]
    assert verdict.exit_code is ExitCode.NOT_YET


@pytest.mark.asyncio
async def test_a_passing_first_turn_spends_no_retry(tmp_path):
    calls: list = []
    verdict = await _run(_spec(retries=3), _check_passes_after(1), _launcher(calls), tmp_path)
    assert verdict.ok
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_a_turn_that_timed_out_is_not_prompted_again(tmp_path):
    """Still running is busy, not finished — a second prompt would queue behind it."""
    calls: list = []
    verdict = await _run(_spec(retries=2), _check_passes_after(99),
                         _launcher(calls, ok=False, timed_out=True), tmp_path)
    assert len(calls) == 1
    assert not verdict.ok


@pytest.mark.asyncio
async def test_no_process_means_nothing_to_retry(tmp_path):
    calls: list = []
    verdict = await _run(_spec(retries=2), _check_passes_after(99),
                         _launcher(calls, ok=False, process_id=None), tmp_path)
    assert len(calls) == 1
    assert not verdict.ok


@pytest.mark.asyncio
async def test_without_a_check_a_failed_turn_retries_on_its_own_report(tmp_path):
    """No completion check ⇒ the rung's own report is the only verification there is."""
    calls: list = []

    async def launch(**kw):
        calls.append(kw)
        ok = len(calls) > 1
        return ProcessResult(process_id="proc-1", ok=ok, message="agent finished" if ok else "agent run failed")

    verdict = await _run(_spec(retries=1, check=False), _check_passes_after(0), launch, tmp_path)
    assert verdict.ok
    assert [c.get("process_id") for c in calls] == [None, "proc-1"]
    assert "agent run failed" in calls[1]["prompt"]


def test_retries_belong_to_an_agent_rung_only():
    with pytest.raises(ValidationError, match="does not take retries"):
        AttemptSpec.model_validate({"kind": "command", "commands": {"linux": "true"}, "retries": 1})


def test_retries_cannot_be_negative():
    with pytest.raises(ValidationError):
        AttemptSpec.model_validate({"kind": "agent", "agent": "provisioner", "retries": -1})


# ── the seam: a further turn prompts the existing process, spawns nothing ────

class _Process:
    def __init__(self):
        self.id = "proc-1"
        self.prompts: list = []

    async def prompt(self, text):
        self.prompts.append(text)
        return None

    async def wait(self, timeout=None, on_status=None):
        return None


@pytest.mark.asyncio
async def test_launch_with_a_process_id_prompts_that_process(monkeypatch, tmp_path):
    from flow_sdk.builtin.agent_registry import get_agent_local_deployment  # noqa: F401 — must not be reached
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.core.compute import process_step

    process = _Process()

    async def get_by_id(process_id):
        return process if process_id == "proc-1" else None

    async def no_spawn(*_a, **_kw):
        raise AssertionError("a retry must not spawn a process")

    monkeypatch.setattr(AgenticProcess, "get_by_id", staticmethod(get_by_id))
    monkeypatch.setattr("flow_sdk.builtin.agent_registry.get_agent_local_deployment", no_spawn)

    result = await process_step.launch_step_process(
        agent="provisioner", prompt="again", name="kafka", workdir=Path(tmp_path), process_id="proc-1",
    )
    assert result.ok and result.process_id == "proc-1"
    assert process.prompts == ["again"]

    gone = await process_step.launch_step_process(
        agent="provisioner", prompt="again", name="kafka", workdir=Path(tmp_path), process_id="proc-9",
    )
    assert not gone.ok and "no longer exists" in gone.message


@pytest.mark.asyncio
async def test_a_turn_that_runs_out_of_time_says_so(monkeypatch, tmp_path):
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.core.compute import process_step

    class _Slow(_Process):
        async def wait(self, timeout=None, on_status=None):
            raise TimeoutError

    async def get_by_id(_process_id):
        return _Slow()

    monkeypatch.setattr(AgenticProcess, "get_by_id", staticmethod(get_by_id))
    result = await process_step.launch_step_process(
        agent="provisioner", prompt="again", name="kafka", workdir=Path(tmp_path), process_id="proc-1",
    )
    assert result.timed_out and not result.ok
