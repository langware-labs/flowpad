"""The `ask` rung — an op whose value comes from a person.

No stubs: the real registry, the real runner, the real waiter. The only thing
standing in for a human is the call that delivers the answer, which is exactly
what the HTTP action does in production.

`FLOWPAD_NO_BROWSER` keeps the window-raiser from opening anything — the same
guard `flow start` uses. A question nobody was shown still registers and still
times out, which is the honest outcome and the one these tests assert.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from flow_sdk.core.compute.ask import answer, cancel, open_questions
from flow_sdk.core.compute_op import run_op
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

#: Short enough that a person who never answers does not hold the suite. This
#: PASSES a smaller deadline; it never raises ASK_TIMEOUT_SECONDS.
BRIEF = 0.25


@pytest.fixture(autouse=True)
def _no_browser(monkeypatch):
    monkeypatch.setenv("FLOWPAD_NO_BROWSER", "1")


def _spec(tmp: Path, **over) -> ComputeOpSpec:
    body = {
        "name": "get-api-key",
        "label": "API token",
        "completion_check": {"commands": {__import__("sys").platform: f"cat {tmp / 'token'}"}},
        "attempts": [{"kind": "ask", "prompt": "Service X API token"}],
        "output": {"token": "string"},
    }
    body.update(over)
    return ComputeOpSpec.model_validate(body)


async def _run(spec, tmp_path, *, timeout=BRIEF):
    return await run_op(spec, trusted=True, workdir=Path(tmp_path),
                        platform=__import__("sys").platform, ask_timeout=timeout)


async def _answer_when_asked(reply, *, via=answer) -> None:
    """Act as the person: wait for the question to appear, then respond."""
    for _ in range(200):
        questions = open_questions()
        if questions:
            via(questions[0].id, reply) if via is answer else via(questions[0].id)
            return
        await asyncio.sleep(0.01)
    raise AssertionError("no question was ever raised")


async def test_nobody_answers(tmp_path):
    """The deadline passes. Not a crash, not success — `NOT_YET`, and it says why."""
    said = await _run(_spec(tmp_path), tmp_path)

    assert said.ok is False
    assert said.exit_code is ExitCode.NOT_YET
    assert "no answer within" in said.detail
    assert said.value is None
    assert open_questions() == [], "a question outlived the op that asked it"


async def test_the_person_cancels(tmp_path):
    """Declining is not a machine failure, and it is not success either."""
    spec = _spec(tmp_path)
    run = asyncio.create_task(_run(spec, tmp_path, timeout=5))
    await _answer_when_asked(None, via=cancel)
    said = await run

    assert said.ok is False
    assert said.exit_code is ExitCode.NOT_YET
    assert said.value is None
    assert "cancel" in said.detail.lower()
    assert open_questions() == []


async def test_the_person_answers(tmp_path):
    """The answer becomes the op's value — once the goal actually holds."""
    spec = _spec(tmp_path)

    async def person():
        await _answer_when_asked({"token": "sk-live-1"})
        # Answering is what makes the completion check pass, the way typing a
        # key into a secret store is: the rung produced the value, and the
        # RE-CHECK is what decides the goal is met.
        (tmp_path / "token").write_text('{"token": "sk-live-1"}\n', encoding="utf-8")

    run = asyncio.create_task(_run(spec, tmp_path, timeout=5))
    await person()
    said = await run

    assert said.ok is True
    assert said.exit_code is ExitCode.OK
    assert said.value.token == "sk-live-1"
    assert open_questions() == []


async def test_an_answer_of_the_wrong_shape_is_not_a_value(tmp_path):
    """A declared shape is the contract even when a person is on the other end."""
    spec = _spec(tmp_path)

    async def person():
        await _answer_when_asked({"token": 12345})     # int, not string
        (tmp_path / "token").write_text('{"token": 12345}\n', encoding="utf-8")

    run = asyncio.create_task(_run(spec, tmp_path, timeout=5))
    await person()
    said = await run

    assert said.ok is False
    assert said.exit_code is ExitCode.NOT_YET
    assert "declared output" in said.detail


async def test_an_ask_op_must_declare_what_it_is_asking_for():
    """Caught when the document is read, not with a person already waiting."""
    with pytest.raises(ValueError, match="nothing to ask the person FOR"):
        ComputeOpSpec.model_validate({
            "name": "get-api-key",
            "attempts": [{"kind": "ask", "prompt": "Token?"}],
        })
