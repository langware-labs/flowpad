"""``_AgentRunner.run`` twice with the same message costs ONE agent turn.

A listener redelivers after a crash, and a session is a thread: a second prompt on the same
text is a second, different answer, not a repeat of the first. So the turn is recorded on the
process before it runs and answered from the record after.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import flow_sdk.blocks as blocks
from flow_sdk.blocks import _AgentRunner
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, PromptResult

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


class _Process:
    """A process that remembers its prompts and persists its context_data on save."""

    def __init__(self, transcript_text: str = ""):
        self.id = "p1"
        self.typeid = "agentic_process-p1"
        self.context_data: dict = {}
        self.prompts: list[str] = []
        self.saves = 0
        self.transcript_text = transcript_text
        #: When set, the next turn is not taken — the way a busy process answers.
        self.busy = ""
        #: How the worker ends its turn (None: it idles, the way a good turn ends).
        self.worker = None

    async def send_turn(self, text: str) -> PromptResult:
        if self.busy:
            # The real send_turn answers a turn in flight as `held` — busy.
            return PromptResult.held(self.busy, executor=self.typeid)
        self.prompts.append(text)
        return PromptResult.satisfied("The turn was accepted.", executor=self.typeid)

    async def save(self):
        self.saves += 1
        return self

    async def exit(self):
        return None

    def fetch_worker_status(self):
        """How the worker ended — read the way AgenticProcess.run reads it."""
        from flow_sdk.transcript_analyzer.worker_status import WorkerStatus  # noqa: PLC0415

        return self.worker or WorkerStatus.IDLE


def _message(external_id="<m1>", body="what is 2+2", data_source_id="src"):
    return SimpleNamespace(
        external_id=external_id, body=body, name="", thread_key="t1",
        data_source_id=data_source_id, origin_kind="mail", origin_namespace="s", origin_key=external_id,
    )


@pytest.fixture
def runner(monkeypatch):
    r = _AgentRunner("stub")
    process = _Process()

    async def process_for(m):
        return process

    monkeypatch.setattr(r, "process_for", process_for)

    async def capture(ap):
        return f"answer #{len(ap.prompts)}" if ap.prompts else ap.transcript_text

    monkeypatch.setattr(blocks, "_capture_assistant_reply", capture, raising=False)
    monkeypatch.setattr("flow_sdk.app.actions.execute_prompt._capture_assistant_reply", capture)
    return r, process


async def test_the_same_message_twice_prompts_once_and_answers_the_same(runner):
    r, process = runner
    first = await r.run(_message())
    second = await r.run(_message())
    assert process.prompts == ["what is 2+2"], "one turn, not two"
    assert first.text == second.text == "answer #1"


async def test_the_record_is_on_the_process_and_persisted(runner):
    r, process = runner
    await r.run(_message())
    turns = process.context_data["turns"]
    assert turns["src:mail:s:<m1>"] == {"status": "done", "text": "answer #1"}
    assert process.saves >= 2, "stamped before the prompt, recorded after"


async def test_a_turn_that_died_mid_way_but_finished_is_answered_from_the_transcript(runner):
    r, process = runner
    process.context_data = {"turns": {"src:mail:s:<m1>": {"status": "started"}}}
    process.transcript_text = "the agent did finish"
    out = await r.run(_message())
    assert out.text == "the agent did finish" and process.prompts == []


async def test_a_turn_that_died_before_the_agent_answered_is_run_once(runner):
    r, process = runner
    process.context_data = {"turns": {"src:mail:s:<m1>": {"status": "started"}}}
    process.transcript_text = ""            # nothing came back before the crash
    out = await r.run(_message())
    assert process.prompts == ["what is 2+2"] and out.text == "answer #1"


async def test_different_messages_are_different_turns(runner):
    r, process = runner
    await r.run(_message(external_id="<m1>"))
    await r.run(_message(external_id="<m2>", body="and 3+3"))
    assert process.prompts == ["what is 2+2", "and 3+3"]


async def test_a_request_without_a_source_keys_on_its_own_id(runner):
    r, process = runner
    m = SimpleNamespace(external_id="<req-1>", body="hi", name="", thread_key="t", data_source_id="")
    await r.run(m)
    assert "<req-1>" in process.context_data["turns"]


async def test_the_record_is_bounded(runner):
    r, process = runner
    for i in range(205):
        await r.run(_message(external_id=f"<m{i}>", body=str(i)))
    assert len(process.context_data["turns"]) == 200
    assert "<m0>" not in "".join(process.context_data["turns"])


async def test_a_turn_the_process_refuses_is_returned_not_raised(runner):
    """A busy process answers ``NOT_YET`` with ``ran=False`` — returned, and never
    followed by a transcript read that would hand back the previous turn's text."""
    r, process = runner
    process.busy = "another prompt turn is already in flight for this process"
    out = await r.run(_message())
    assert out.exit_code is ExitCode.NOT_YET and out.ran is False
    assert out.detail == process.busy and out.text == ""
    assert out.executor == "agentic_process-p1"
    assert process.prompts == []


async def test_a_taken_turn_names_the_process_that_answered(runner):
    r, process = runner
    out = await r.run(_message())
    assert out.ok and out.executor == "agentic_process-p1"



# ── how a turn ENDS: one PromptResult, whatever became of it ────────────────


async def test_a_busy_process_answers_busy_and_records_nothing(runner):
    r, process = runner
    process.busy = "another prompt turn is already in flight for this process"
    out = await r.run(_message())
    assert out.exit_code is ExitCode.NOT_YET and out.busy and out.ran is False
    assert out.executor == process.typeid, "a caller can still name the process"
    assert "src:mail:s:<m1>" not in process.context_data.get("turns", {})


async def test_a_turn_that_ended_in_error_is_not_answered_as_a_success(runner):
    """The engine used to answer `done` with whatever text an errored worker left.
    It reads the worker's end the way AgenticProcess.run does — and records the
    failure, so a redelivery does not re-run what may have half-happened."""
    from flow_sdk.transcript_analyzer.worker_status import WorkerStatus

    r, process = runner
    process.worker = WorkerStatus.ERROR
    out = await r.run(_message())
    assert out.exit_code is ExitCode.NOT_YET and not out.busy
    assert process.context_data["turns"]["src:mail:s:<m1>"]["status"] == "failed"

    again = await r.run(_message())
    assert process.prompts == ["what is 2+2"], "a failed turn is not re-run by a redelivery"
    assert again.exit_code is ExitCode.NOT_YET and again.ran is False


async def test_a_turn_that_ran_out_of_time_answers_timed_out_and_keeps_its_stamp(runner, monkeypatch):
    """The wait ended, not necessarily the turn — so it is NOT_YET with
    `timed_out`, never a raise (a raise killed the serve loop), and the STARTED
    stamp stays so a redelivery reads the transcript to learn how it ended."""
    r, process = runner

    async def slow(_ap):
        raise TimeoutError

    monkeypatch.setattr("flow_sdk.app.actions.execute_prompt._capture_assistant_reply", slow)
    out = await r.run(_message())
    assert out.exit_code is ExitCode.NOT_YET and out.timed_out and out.executor == process.typeid
    assert process.context_data["turns"]["src:mail:s:<m1>"]["status"] == "started"


async def test_a_replayed_turn_is_answered_without_running(runner):
    r, process = runner
    await r.run(_message())
    again = await r.run(_message())
    assert again.ok and again.ran is False and again.text == "answer #1"
