"""A wizard step whose caller is cancelled (a setup run replaced by a newer one) leaves
nothing behind: the agent it spawned is closed, and the question it raised is taken off
the person's screen. `run_shell` already kills its process group on cancel."""

from __future__ import annotations

import asyncio

import pytest

from flow_sdk.schema.data_spec.returned_value_spec import PromptResult


class _HungProcess:
    id = "p1"
    typeid = "agentic_process-p1"

    def __init__(self):
        self.closed = False

    async def send_turn(self, prompt):
        return PromptResult.satisfied("taken")

    async def wait(self, *, timeout, on_status=None):
        await asyncio.Event().wait()

    async def close(self):
        self.closed = True
        return True


@pytest.mark.asyncio
async def test_a_cancelled_agent_step_closes_its_agent():
    from flow_sdk.core.compute.process_step import _prompt_and_wait

    process = _HungProcess()
    step = asyncio.ensure_future(_prompt_and_wait(process, "go", timeout_seconds=60, on_status=None))
    await asyncio.sleep(0)
    step.cancel()
    with pytest.raises(asyncio.CancelledError):
        await step
    assert process.closed, "the agent kept running after its step was cancelled"


@pytest.mark.asyncio
async def test_a_cancelled_ask_withdraws_its_question(monkeypatch):
    from flow_sdk.core.compute_op import ask, ask_window

    withdrawn: list[str] = []

    async def _raise(question, *, try_window=True):
        return True

    async def _withdraw(question):
        withdrawn.append(question.id)

    monkeypatch.setattr(ask_window, "raise_question", _raise)
    monkeypatch.setattr(ask_window, "withdraw_question", _withdraw)

    asking = asyncio.ensure_future(ask.ask_person("op", "Install?", "string", timeout=60, label="Tool"))
    await asyncio.sleep(0)
    (question,) = ask.open_questions()
    asking.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asking
    assert withdrawn == [question.id]
    assert ask.open_questions() == []
