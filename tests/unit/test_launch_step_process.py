"""``launch_step_process`` — one agent turn, answered as a ``PromptResult``.

With ``process_id`` it prompts THAT process: a further turn in the same
session, which is how a caller continues an agent op (``run_op(executor=…)``).
Nothing is spawned for it.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, PromptResult

pytestmark = pytest.mark.timeout(5)


class _Process:
    """An agent process: takes a turn, and ``wait()`` returns when it has ended."""

    def __init__(self):
        self.id = "proc-1"
        self.prompts: list = []

    async def wait(self, timeout=None, on_status=None):
        return None

    @property
    def typeid(self):
        return f"agentic_process-{self.id}"

    async def send_turn(self, text):
        self.prompts.append(text)
        return PromptResult.satisfied("The turn was accepted.", executor=self.typeid)



@pytest.mark.asyncio
async def test_launch_with_a_process_id_prompts_that_process(monkeypatch, tmp_path):
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.core.compute import process_step

    process = _Process()

    async def get_by_typeid(typeid):
        return process if str(typeid) == "agentic_process-proc-1" else None

    async def no_spawn(*_a, **_kw):
        raise AssertionError("a further turn must not spawn a process")

    monkeypatch.setattr(AgenticProcess, "get_by_typeid", staticmethod(get_by_typeid))
    monkeypatch.setattr("flow_sdk.builtin.agent_registry.get_agent_local_deployment", no_spawn)

    result = await process_step.launch_step_process(
        agent="provisioner", prompt="again", name="kafka", workdir=Path(tmp_path), executor="agentic_process-proc-1",
    )
    assert isinstance(result, PromptResult)
    assert result.ok and result.executor == "agentic_process-proc-1"
    assert process.prompts == ["again"]

    gone = await process_step.launch_step_process(
        agent="provisioner", prompt="again", name="kafka", workdir=Path(tmp_path), executor="agentic_process-proc-9",
    )
    assert not gone.ok and gone.ran is False and "no longer exists" in gone.detail


@pytest.mark.asyncio
async def test_a_turn_that_runs_out_of_time_says_so(monkeypatch, tmp_path):
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.core.compute import process_step

    class _Slow(_Process):
        async def wait(self, timeout=None, on_status=None):
            raise TimeoutError  # the turn outlived its budget

    async def get_by_typeid(_typeid):
        return _Slow()

    monkeypatch.setattr(AgenticProcess, "get_by_typeid", staticmethod(get_by_typeid))
    result = await process_step.launch_step_process(
        agent="provisioner", prompt="again", name="kafka", workdir=Path(tmp_path), executor="agentic_process-proc-1",
    )
    # Busy, not finished: the executor is named so the caller knows WHICH
    # process is still running — and must not be prompted on top of itself.
    assert result.timed_out and result.exit_code is ExitCode.NOT_YET
    assert result.executor == "agentic_process-proc-1"
