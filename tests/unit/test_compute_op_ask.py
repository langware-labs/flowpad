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
from unittest.mock import AsyncMock

import pytest

from flow_sdk.core.compute.ask import answer, cancel, open_questions
from flow_sdk.core.compute_op import run_op
from flow_sdk.schema.data_spec.compute_op_spec import ASK_TIMEOUT_SECONDS, ComputeOpSpec
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
    return await run_op(spec, trusted=True, workdir=Path(tmp_path), platform=sys.platform, ask_timeout=timeout)


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


async def test_the_op_words_its_own_buttons(tmp_path):
    """`submit_label` / `cancel_label` reach the window's payload as written."""
    exe = {"prompt": "Install Git?", "submit_label": "Install", "cancel_label": "Skip"}
    run = asyncio.create_task(_run(_spec(tmp_path, exe_data=exe), tmp_path, timeout=5))
    for _ in range(200):
        if open_questions():
            break
        await asyncio.sleep(0.01)
    payload = open_questions()[0].to_payload()
    cancel(payload["id"])
    await run

    assert payload["submit_label"] == "Install"
    assert payload["cancel_label"] == "Skip"


async def test_unworded_buttons_leave_the_defaults_to_the_window(tmp_path):
    """Empty labels: the window draws its own Send / Cancel."""
    run = asyncio.create_task(_run(_spec(tmp_path), tmp_path, timeout=5))
    for _ in range(200):
        if open_questions():
            break
        await asyncio.sleep(0.01)
    payload = open_questions()[0].to_payload()
    cancel(payload["id"])
    await run

    assert payload["submit_label"] == "" and payload["cancel_label"] == ""


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
        ComputeOpSpec.model_validate(
            {
                "name": "get-api-key",
                "subkind": "ask",
                "exe_data": {"prompt": "Token?"},
            }
        )


def test_until_answered_and_timeout_seconds_together_is_refused():
    """`until_answered` would win at runtime either way (see the runner) —
    refusing the document is better than an author's explicit budget being
    silently dropped with nothing to say why the wait outlived it."""
    with pytest.raises(ValueError, match="cannot set both"):
        ComputeOpSpec.model_validate(
            {
                "name": "get-api-key",
                "subkind": "ask",
                "exe_data": {"prompt": "Token?", "until_answered": True, "timeout_seconds": 30},
                "output_spec_kind": "test.ask.api_token",
            }
        )


def _until_answered_spec(tmp: Path, **over) -> ComputeOpSpec:
    return _spec(tmp, exe_data={"prompt": "Service X API token", "until_answered": True}, **over)


#: The "full budget" caller timeout — `ask_timeout >= ASK_TIMEOUT_SECONDS` is
#: exactly the condition the runner checks to grant `until_answered` its
#: unbounded wait. `min()` in a shorter number here does NOT simulate a longer
#: wait; it does the opposite (see the failed first draft of these tests) —
#: these must pass the real constant, never a patched one.
FULL_BUDGET = ASK_TIMEOUT_SECONDS


async def test_until_answered_reaches_wait_for_with_no_deadline(tmp_path, monkeypatch):
    """The whole point, proven without waiting out a real 60s: a caller that
    allows the full budget (no explicit SHORTER `ask_timeout`) gets no deadline
    at all passed to the waiter, not just a longer one."""
    from flow_sdk.core.compute import ask as ask_module
    from flow_sdk.core.compute import ask_window

    # A live tab from the first attempt: nothing here is testing the presence
    # grace (that is `test_nobody_to_show_it_to_...` / `test_a_tab_that_...`),
    # so skip straight past it into the wait this test actually asserts on.
    monkeypatch.setattr(ask_window, "raise_question", AsyncMock(return_value=True))
    deadlines = []
    real_wait = ask_module.wait_for

    async def spy(question, *, timeout):
        deadlines.append(timeout)
        return await real_wait(question, timeout=timeout)

    monkeypatch.setattr(ask_module, "wait_for", spy)
    spec = _until_answered_spec(tmp_path)

    run = asyncio.create_task(_run(spec, tmp_path, timeout=FULL_BUDGET))
    await _answer_when_asked({"token": "sk-live-1"})
    said = await run

    assert said.ok is True and said.value.token == "sk-live-1"
    assert deadlines == [None]


async def test_a_shorter_caller_deadline_still_bounds_an_until_answered_op(tmp_path):
    """`until_answered` widens the DEFAULT; it does not override a caller that
    explicitly asks for less — "a caller may pass a shorter deadline" still
    holds for this op like any other."""
    spec = _until_answered_spec(tmp_path)
    said = await _run(spec, tmp_path, timeout=BRIEF)

    assert said.exit_code is ExitCode.NOT_YET
    assert said.timed_out is True
    assert open_questions() == []


async def test_nobody_to_show_it_to_gives_up_after_the_presence_grace(tmp_path, monkeypatch):
    """No live tab and `FLOWPAD_NO_BROWSER` (this file's fixture): the op does
    not hang forever holding its caller — it gives the boot-race window a
    chance (`PRESENCE_GRACE_SECONDS`) and then reports precisely that: nobody
    was there, nothing ran, and the question is gone rather than orphaned."""
    from flow_sdk.core.compute_op import runner as op_runner

    monkeypatch.setattr(op_runner, "PRESENCE_GRACE_SECONDS", 0.05)
    monkeypatch.setattr(op_runner, "PRESENCE_POLL_SECONDS", 0.01)
    spec = _until_answered_spec(tmp_path)

    said = await _run(spec, tmp_path, timeout=FULL_BUDGET)

    assert said.exit_code is ExitCode.NOT_YET
    assert said.ran is False
    assert open_questions() == []


async def test_a_tab_that_connects_during_the_grace_window_still_gets_asked(tmp_path, monkeypatch):
    """The boot race this grace window exists for: `app.ready` can fire before
    the app's own tab finishes its WS handshake. A tab a moment late must still
    see the question, not lose it to an instant give-up."""
    from flow_sdk.core.compute import ask_window
    from flow_sdk.core.compute_op import runner as op_runner

    monkeypatch.setattr(op_runner, "PRESENCE_GRACE_SECONDS", 0.3)
    monkeypatch.setattr(op_runner, "PRESENCE_POLL_SECONDS", 0.02)
    attempts: list[bool] = []

    async def flaky_push(question) -> bool:
        attempts.append(True)
        return len(attempts) >= 3  # "connects" on the third look

    monkeypatch.setattr(ask_window, "_push_to_live_tab", flaky_push)
    spec = _until_answered_spec(tmp_path)

    run = asyncio.create_task(_run(spec, tmp_path, timeout=FULL_BUDGET))
    await _answer_when_asked({"token": "sk-live-1"})
    said = await run

    assert said.ok is True
    assert said.value.token == "sk-live-1"
    assert len(attempts) >= 3


async def test_the_browser_fallback_is_tried_once_not_once_per_poll(tmp_path, monkeypatch):
    """A window that failed to open once (headless, `FLOWPAD_NO_BROWSER`) must
    not be retried on every presence poll — that would spam a fresh tab every
    `PRESENCE_POLL_SECONDS` instead of failing the same way every time."""
    from flow_sdk.core.compute import ask_window
    from flow_sdk.core.compute_op import runner as op_runner

    monkeypatch.setattr(op_runner, "PRESENCE_GRACE_SECONDS", 0.05)
    monkeypatch.setattr(op_runner, "PRESENCE_POLL_SECONDS", 0.01)
    window_calls = []

    async def counted_window(_q) -> bool:
        window_calls.append(1)
        return False

    monkeypatch.setattr(ask_window, "_open_a_window", counted_window)
    spec = _until_answered_spec(tmp_path)

    said = await _run(spec, tmp_path, timeout=FULL_BUDGET)

    assert said.exit_code is ExitCode.NOT_YET and said.ran is False
    assert len(window_calls) == 1
