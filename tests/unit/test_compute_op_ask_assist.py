"""AI Assist on an `ask` op — an agent answers the SAME question a person would.

The real runner, the real waiter, the real registry. The agent is the one seam: a `launch` that acts
as the agent does in production — it answers the open question through `ask.answer` (what
`flow ask answer` posts to) — so what is asserted is what the caller sees: the same `AskResult`
whoever answered, a deadline that becomes the setup's own once the agent starts, and a question that
stays open for the person when the agent fails.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands import ask_cmd
from flow_sdk.core.compute.process_step import ProcessProgress
from flow_sdk.core.compute_op import ask, run_op
from flow_sdk.core.compute_op.ask import AssistRefused, answer, open_questions
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import AskResult, ExitCode, PromptResult

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

#: The person's span in these tests — short, so an assist that did NOT extend it would time out.
BRIEF = 0.2


@pytest.fixture(autouse=True)
def _served_here(monkeypatch):
    monkeypatch.setenv("FLOWPAD_NO_BROWSER", "1")
    monkeypatch.setattr(ask, "_SERVED_HERE", True)
    ask._PENDING.clear()
    yield
    ask._PENDING.clear()


def _spec(*, assist_agent: str = "provisioner", setup_timeout: float = 2.0, file: bool = False) -> ComputeOpSpec:
    return ComputeOpSpec.model_validate({
        "name": "ask-gcp-KEY",
        "label": "Google Cloud: service-account key",
        "subkind": "ask",
        "output_spec_kind": "string",
        "exe_data": {"prompt": "Google Cloud: service-account key", "secret": True, "file": file,
                     "assist_agent": assist_agent},
        "setup": "1. Open IAM → Service accounts.\n2. Create a key.",
        "setup_timeout_seconds": setup_timeout,
    })


def _run(spec: ComputeOpSpec, tmp_path: Path, timeout: float = BRIEF):
    return asyncio.create_task(
        run_op(spec, trusted=True, workdir=tmp_path, platform=sys.platform, ask_timeout=timeout)
    )


async def _question() -> ask.Question:
    for _ in range(200):
        if open_questions():
            return open_questions()[0]
        await asyncio.sleep(0.01)
    raise AssertionError("no question was ever raised")


def _agent(*, answers: str | None = None, after: float = 0.0, said: PromptResult | None = None, log: list | None = None):
    """A `launch` standing in for the spawned agent: reports its process, works ``after`` seconds, then
    answers the open question (as `flow ask answer` does) — or not."""

    async def launch(**kwargs):
        (log if log is not None else []).append(kwargs)
        kwargs["on_status"](ProcessProgress(text="starting the agent", executor="agentic_process-abc"))
        try:
            await asyncio.sleep(after)
        except asyncio.CancelledError:
            (log if log is not None else []).append("cancelled")
            raise
        if answers is not None:
            (question,) = open_questions()
            answer(question.id, answers)
        return said or PromptResult.satisfied("done", ran=True)

    return launch


async def test_an_assisted_answer_is_the_same_answer_as_a_persons(tmp_path):
    by_person = _run(_spec(), tmp_path, timeout=5)
    answer((await _question()).id, "KEY-JSON")
    person = await by_person

    by_agent = _run(_spec(), tmp_path, timeout=5)
    ask.assist((await _question()).id, launch=_agent(answers="KEY-JSON"))
    agent = await by_agent

    assert isinstance(agent, AskResult) and agent.ok
    same = {"duration_s"}  # how long it took, not what was answered
    assert agent.model_dump(exclude=same) == person.model_dump(exclude=same), "the caller cannot tell who answered"
    assert open_questions() == []


async def test_starting_an_assist_gives_the_question_the_setups_own_span(tmp_path):
    """The person's span is BRIEF; the agent answers well after it — the question waited for it."""
    run = _run(_spec(setup_timeout=2.0), tmp_path, timeout=BRIEF)
    ask.assist((await _question()).id, launch=_agent(answers="KEY-JSON", after=BRIEF * 2))

    said = await run

    assert said.ok and said.value == "KEY-JSON"


async def test_the_agent_gets_the_guide_the_contract_and_the_setup_timeout(tmp_path):
    log: list = []
    run = _run(_spec(setup_timeout=2.0, file=True), tmp_path, timeout=5)
    question = await _question()
    ask.assist(question.id, launch=_agent(answers="KEY-JSON", log=log))
    await run

    (call,) = [c for c in log if isinstance(c, dict)]
    assert call["agent"] == "provisioner" and call["timeout_seconds"] == 2.0
    assert "Create a key." in call["prompt"], "the op's guide is how the agent does it"
    assert f"ask answer {question.id} --file" in call["prompt"], "a file answer is delivered as a file"
    assert Path(call["workdir"]) == tmp_path


async def test_an_assist_that_fails_leaves_the_question_to_the_person(tmp_path):
    run = _run(_spec(), tmp_path, timeout=5)
    question = await _question()
    ask.assist(question.id, launch=_agent(said=PromptResult.not_yet("needs the person's Google sign-in")))
    for _ in range(200):
        if question.assist_state == "failed":
            break
        await asyncio.sleep(0.01)

    payload = question.to_payload()
    assert payload["assist"] == {
        "state": "failed", "detail": "needs the person's Google sign-in", "process": "agentic_process-abc",
    }
    answer(question.id, "KEY-JSON")
    assert (await run).value == "KEY-JSON"


async def test_an_assist_that_runs_out_of_time_stops_its_agent(tmp_path):
    log: list = []
    run = _run(_spec(setup_timeout=0.3), tmp_path, timeout=BRIEF)
    ask.assist((await _question()).id, launch=_agent(after=60, log=log))

    said = await run
    await asyncio.sleep(0)

    assert said.exit_code is ExitCode.NOT_YET and said.timed_out
    assert "cancelled" in log, "nobody waits for the answer: the agent is stopped"


async def test_one_assist_at_a_time_and_none_without_an_agent(tmp_path):
    run = _run(_spec(), tmp_path, timeout=5)
    question = await _question()
    assert question.to_payload()["assist_available"] is True
    ask.assist(question.id, launch=_agent(after=60))
    with pytest.raises(AssistRefused, match="already working"):
        ask.assist(question.id, launch=_agent())
    answer(question.id, "KEY-JSON")
    await run

    run = _run(_spec(assist_agent=""), tmp_path, timeout=5)
    question = await _question()
    assert question.to_payload()["assist_available"] is False
    with pytest.raises(AssistRefused, match="no AI Assist"):
        ask.assist(question.id, launch=_agent())
    answer(question.id, "x")
    await run


# ── `flow ask answer` — how the agent delivers ───────────────────────────────


@pytest.fixture
def posted(monkeypatch):
    sent: list = []

    class _Response:
        def json(self):
            return {"status": "SUCCESS", "data": {}}

    def fake_request(method, url, **kwargs):
        sent.append((method, url, kwargs["json"]))
        return _Response()

    monkeypatch.setattr(ask_cmd, "discover_port", lambda: 1234)
    monkeypatch.setattr(ask_cmd, "local_request", fake_request)
    return sent


def test_the_cli_answers_with_a_files_content_and_prints_no_value(posted, tmp_path):
    key = tmp_path / "key.json"
    key.write_text('{"type": "service_account"}')

    result = CliRunner().invoke(ask_cmd.ask_app, ["answer", "q-1", "--file", str(key)])

    assert result.exit_code == 0, result.output
    assert posted == [("POST", "http://127.0.0.1:1234/api/v1/ask/q-1/answer", {"value": '{"type": "service_account"}'})]
    assert "service_account" not in result.output
    assert json.loads(result.output) == {"ok": True, "answered": "q-1"}


def test_the_cli_reads_stdin_and_refuses_an_empty_value(posted):
    ok = CliRunner().invoke(ask_cmd.ask_app, ["answer", "q-1", "--stdin"], input="sk-123\n")
    empty = CliRunner().invoke(ask_cmd.ask_app, ["answer", "q-1", "--stdin"], input="\n")

    assert ok.exit_code == 0 and posted[0][2] == {"value": "sk-123"}
    assert empty.exit_code == ask_cmd.EXIT_REFUSED and len(posted) == 1
