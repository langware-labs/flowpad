"""The `ask` subkind — an op whose value comes from a person.

No stubs: the real registry, the real runner, the real waiter. The only thing
standing in for a human is the call that delivers the answer, which is exactly
what the HTTP action does in production.

`FLOWPAD_NO_BROWSER` keeps the window-raiser from opening anything — the same
guard `flow start` uses. A question nobody was shown still registers and still
times out, which is the honest outcome and the one these tests assert.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import ClassVar

import pytest

from flow_sdk.core.compute.ask import answer, cancel, open_questions
from flow_sdk.core.compute_op import run_op
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import AskResult, ExitCode
from flow_sdk.schema.data_spec.spec import DataSpec

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

#: Short enough that a person who never answers does not hold the suite. This
#: PASSES a smaller deadline; it never raises ASK_TIMEOUT_SECONDS.
BRIEF = 0.25


class ApiToken(DataSpec):
    spec_kind: ClassVar[str] = "test.ask.api_token"
    token: str


@pytest.fixture(autouse=True)
def _no_browser(monkeypatch):
    monkeypatch.setenv("FLOWPAD_NO_BROWSER", "1")


@pytest.fixture(autouse=True)
def _only_our_questions():
    """The pending-question registry is process-global.

    These tests assert that nothing is left waiting, which is a statement about
    THIS op — not about whatever another test in the same process left behind.
    Clearing it on the way in and out makes that assertion mean what it says.
    """
    from flow_sdk.core.compute import ask

    ask._PENDING.clear()
    yield
    ask._PENDING.clear()


def _spec(tmp: Path, **over) -> ComputeOpSpec:
    body = {
        "name": "get-api-key",
        "label": "API token",
        "subkind": "ask",
        "exe_data": {"prompt": "Service X API token"},
        "completion_check": {"commands": {sys.platform: f"cat {tmp / 'token'}"}},
        "output_spec_kind": "test.ask.api_token",
    }
    body.update(over)
    return ComputeOpSpec.model_validate(body)


async def _run(spec, tmp_path, *, timeout=BRIEF):
    return await run_op(spec, trusted=True, workdir=Path(tmp_path),
                        platform=sys.platform, ask_timeout=timeout)


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

    assert isinstance(said, AskResult)
    assert said.ok is False
    assert said.exit_code is ExitCode.NOT_YET
    assert said.timed_out is True and said.cancelled is False
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
    assert said.cancelled is True and said.timed_out is False
    assert said.value is None
    assert open_questions() == []


async def test_the_person_answers(tmp_path):
    """A valid answer IS the verdict of an ask — no re-check: a person, not a
    command, verified it. Nothing stored it yet, and the op does not need it to."""
    spec = _spec(tmp_path)

    run = asyncio.create_task(_run(spec, tmp_path, timeout=5))
    await _answer_when_asked({"token": "sk-live-1"})
    said = await run

    assert said.ok is True and said.ran is True
    assert said.exit_code is ExitCode.OK
    assert isinstance(said.value, ApiToken) and said.value.token == "sk-live-1"
    assert open_questions() == []


async def test_a_stored_answer_is_read_off_the_check_and_nobody_is_asked(tmp_path):
    """The check decides whether to ask at all. Once something stored the value,
    the op answers from what the check prints — ``ran=False``."""
    (tmp_path / "token").write_text('{"token": "sk-live-1"}\n', encoding="utf-8")
    said = await _run(_spec(tmp_path), tmp_path)

    assert said.ok is True and said.ran is False
    assert said.value.token == "sk-live-1"
    assert open_questions() == [], "nobody was asked"


async def test_an_answer_of_the_wrong_shape_is_not_a_value(tmp_path):
    """A declared shape is the contract even when a person is on the other end."""
    spec = _spec(tmp_path)

    run = asyncio.create_task(_run(spec, tmp_path, timeout=5))
    await _answer_when_asked({"token": ["not", "a", "string"]})
    said = await run

    assert said.ok is False
    assert said.exit_code is ExitCode.NOT_YET
    assert "test.ask.api_token" in said.detail


async def test_an_ask_op_must_declare_what_it_is_asking_for():
    """Caught when the document is read, not with a person already waiting."""
    with pytest.raises(ValueError, match="nothing to ask the person FOR"):
        ComputeOpSpec.model_validate({
            "name": "get-api-key", "subkind": "ask", "exe_data": {"prompt": "Token?"},
        })
