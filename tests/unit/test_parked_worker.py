"""A print-mode worker the agent left background work running in stays alive between turns.

The CLI answers, goes ``idle`` and keeps running for the work it was asked to watch. While it
is parked the user must not be blocked: ``busy`` is false, and a message they send goes to the
SAME process and is answered while the work carries on. The pieces:

* ``ClaudeCLIStreamWorker`` — keeps stdin open while the CLI reports idle WITH background work,
  closes it once there is none, and takes a message while parked;
* ``WorkerTurns`` — a turn begins when a message is delivered (or the CLI starts one itself) and
  ends at ``idle``; the listener of a turn is closed exactly once;
* the registry predicates behind ``busy`` — a parked worker is registered but is not a turn.
"""

from __future__ import annotations

import asyncio
import json
import sys
import textwrap
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process.agentic_process import (
    AgenticProcess,
    any_prompt_in_flight,
    prompt_worker_active,
    prompt_worker_parked,
    register_prompt_worker,
    unregister_prompt_worker,
)
from flow_sdk.builtin.agentic_process.cli_drivers.claude import ClaudeCLIStreamWorker
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgenticContext
from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy
from flow_sdk.builtin.agentic_process.worker_turns import WorkerTurns, worker_turns_for
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData, FlowElementType
from flow_sdk.flowpad_types.enums.worker_enums import WorkerType
from tests.utils.fake_cli import patch_build_spawn

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


# ── a CLI that behaves like claude -p with background work ───────────────────────────────────

FAKE_CLAUDE = textwrap.dedent(
    """
    import json, sys

    def emit(event):
        print(json.dumps(event), flush=True)

    def state(name):
        emit({"type": "system", "subtype": "session_state_changed", "state": name})

    def tasks(ids):
        emit({"type": "system", "subtype": "background_tasks_changed",
              "tasks": [{"task_id": i, "task_type": "local_bash"} for i in ids]})

    def say(text):
        emit({"type": "assistant", "message": {"content": [{"type": "text", "text": text}], "stop_reason": None}})
        emit({"type": "result", "subtype": "success", "total_cost_usd": 0.0, "duration_ms": 1})

    for line in sys.stdin:
        message = json.loads(line)
        if message.get("type") != "user":
            continue
        text = message["message"]["content"][0]["text"]
        state("running")
        if text == "launch":
            tasks(["b1"])
            say("launched")
        elif text == "FINISH":
            # The background work ends: the CLI reports it and takes a turn of its own.
            tasks([])
            emit({"type": "system", "subtype": "task_notification", "task_id": "b1", "status": "completed"})
            say("report")
        else:
            say("pong")
        state("idle")
    """
)


def _user_message(text: str) -> str:
    return json.dumps({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}}) + "\n"


@pytest.fixture
def parked_cli(monkeypatch, tmp_path: Path):
    """A worker whose CLI is the fake above, first message ``launch``. Returns (worker, context)."""
    script = tmp_path / "fake_claude.py"
    script.write_text(FAKE_CLAUDE, encoding="utf-8")
    patch_build_spawn(
        monkeypatch, ClaudeCLIStreamWorker, [sys.executable, str(script)], env=None, stdin=_user_message("launch")
    )
    return ClaudeCLIStreamWorker(), AgenticContext(workdir=str(tmp_path))


def _chat_texts(frames: list[FlowData]) -> list[str]:
    return [str(f.flow_value) for f in frames if f.attributes.get("element-type") == FlowElementType.CHAT]


async def test_a_message_sent_while_background_work_runs_is_answered_by_the_same_process(parked_cli):
    """The whole point: stdin stays open at the turn's ``result`` while work runs, a second message is
    written to the SAME process and answered, and the process exits only once the work has ended."""
    worker, context = parked_cli
    frames: list[FlowData] = []
    stage = 0
    pids: set[int] = set()

    async for fd in worker.execute(prompt="launch", context=context):
        frames.append(fd)
        pids.add(worker._proc.pid)
        if stage == 0 and worker.parked:
            # The first turn answered and went idle, but the CLI reported work still running.
            assert worker.claim_for_message()
            assert not worker.parked  # claimed: a second delivery can no longer take it
            assert await worker.write_user_message("ping")
            stage = 1
        elif stage == 1 and "pong" in _chat_texts(frames) and worker.parked:
            assert worker.claim_for_message()
            assert await worker.write_user_message("FINISH")
            stage = 2

    assert stage == 2, "the worker never parked — stdin was closed at the first result"
    assert _chat_texts(frames) == ["launched", "pong", "report"]
    assert len(pids) == 1, "every message went to the one process"
    assert not worker.parked  # exited: nothing left to take a message


async def test_stdin_closes_at_idle_when_no_background_work_is_left(parked_cli, monkeypatch, tmp_path):
    """An ordinary turn (no background work) still ends with the process: the CLI is told there is
    nothing more at its ``idle``, so it exits and the stream ends."""
    worker, context = parked_cli
    # The same fake, but the first turn launches nothing.
    patch_build_spawn(
        monkeypatch,
        ClaudeCLIStreamWorker,
        [sys.executable, str(tmp_path / "fake_claude.py")],
        stdin=_user_message("hi"),
    )

    frames = [fd async for fd in worker.execute(prompt="hi", context=context)]

    assert _chat_texts(frames) == ["pong"]
    assert not worker.parked
    assert worker._proc.returncode == 0


async def test_only_one_of_two_racing_deliveries_gets_the_parked_worker(parked_cli):
    worker, context = parked_cli
    seen: dict[str, bool] = {}

    async for _ in worker.execute(prompt="launch", context=context):
        if worker.parked and "first" not in seen:
            seen["first"] = worker.claim_for_message()
            seen["second"] = worker.claim_for_message()
            await worker.write_user_message("FINISH")

    assert seen == {"first": True, "second": False}


async def test_stopping_a_parked_worker_ends_its_process_without_an_abort_or_a_crash(parked_cli):
    """No turn is running — the CLI is idle for the work the agent left behind — so stopping it is the user
    ending that work: the process goes, and no "aborted" or "exited with code" frame is invented for it."""
    worker, context = parked_cli
    frames: list[FlowData] = []
    stopped: list[bool] = []

    async for fd in worker.execute(prompt="launch", context=context):
        frames.append(fd)
        if worker.parked and not stopped:
            stopped.append(await worker.stop_parked())

    assert stopped == [True]
    assert not worker.parked and worker._proc.returncode is not None
    subtypes = [
        f.attributes.get("subtype") for f in frames if f.attributes.get("element-type") == FlowElementType.STATUS
    ]
    assert "turn_aborted" not in subtypes and "exit-error" not in subtypes


async def test_a_worker_that_is_not_parked_cannot_be_stopped_as_background_work(parked_cli):
    worker, context = parked_cli
    results: list[bool] = []

    async for _ in worker.execute(prompt="launch", context=context):
        if not worker.parked and not results:
            results.append(await worker.stop_parked())  # mid-turn: stopping a TURN is cancel-prompt's job
        if worker.parked:
            assert worker.claim_for_message()
            await worker.write_user_message("FINISH")  # let the fake CLI finish

    assert results == [False]


# ── WorkerTurns: what each edge does to ``busy`` ─────────────────────────────────────────────


class _Sink:
    def __init__(self) -> None:
        self.frames: list = []
        self.closed = 0

    async def on_flow_data(self, flow_data) -> None:
        if flow_data is None:
            self.closed += 1
        else:
            self.frames.append(flow_data)


class _Process:
    """Just what ``WorkerTurns`` asks of a process: a flag, a broadcast, and the end-of-turn tail."""

    id = "p1"

    def __init__(self) -> None:
        self._turn_in_flight = False
        self.broadcasts = 0
        self.tails = 0

    async def notify_updated(self) -> None:
        self.broadcasts += 1

    async def end_headless_turn(self, _prefix: str) -> None:
        self._turn_in_flight = False
        self.tails += 1


class _Worker:
    def __init__(self) -> None:
        self.session_state: str | None = "running"
        self.is_parked = False
        self.written: list[str] = []
        self.write_ok = True

    @property
    def parked(self) -> bool:
        return self.is_parked and self.session_state == "idle"

    def claim_for_message(self) -> bool:
        if not self.parked:
            return False
        self.session_state = "running"
        return True

    async def write_user_message(self, text: str) -> bool:
        self.written.append(text)
        return self.write_ok


def _state_frame() -> FlowData:
    from flow_sdk.builtin.agentic_process.cli_drivers.replay_envelope import status_frame

    return status_frame("session_state_changed", "{}")


def _content_frame() -> FlowData:
    from flow_sdk.builtin.agentic_process.cli_drivers.replay_envelope import status_frame

    return status_frame("task_started", "{}")


@pytest.fixture
def turns_env():
    process, worker, lock = _Process(), _Worker(), asyncio.Lock()
    return process, worker, lock, WorkerTurns(process, worker, log_prefix="t", lock=lock)


async def test_state_frames_are_control_and_everything_else_passes_through(turns_env):
    _, _, _, turns = turns_env
    content = _content_frame()

    assert await turns.route(content) is content
    assert await turns.route(_state_frame()) is None


async def test_idle_with_the_process_staying_ends_the_turn_once(turns_env):
    process, worker, lock, turns = turns_env
    sink = _Sink()
    await turns.begin(sink, announce=False)
    assert lock.locked() and process._turn_in_flight

    worker.is_parked, worker.session_state = True, "idle"
    await turns.route(_state_frame())
    await turns.route(_state_frame())  # a repeated idle changes nothing

    assert sink.closed == 1  # the listener of that turn is released
    assert not lock.locked()  # and so is the slot, so a message can start the next one
    assert process.tails == 1 and not process._turn_in_flight


async def test_idle_with_the_process_exiting_leaves_the_turn_for_the_runners_own_end(turns_env):
    process, worker, lock, turns = turns_env
    sink = _Sink()
    await turns.begin(sink, announce=False)

    worker.is_parked, worker.session_state = False, "idle"  # stdin already closed: it is exiting
    await turns.route(_state_frame())

    assert sink.closed == 0 and process.tails == 0 and lock.locked()


async def test_an_old_idle_does_not_end_the_turn_a_delivered_message_started(turns_env):
    """A state frame can be handled a moment after the CLI wrote it; by then the message may have been
    delivered, flipping the worker to ``running``. The previous turn's idle must not end THAT turn."""
    process, worker, _, turns = turns_env
    worker.is_parked, worker.session_state = True, "idle"
    sink = _Sink()
    await turns.begin(sink, announce=False)
    worker.claim_for_message()  # the next message took the worker before the idle frame was handled

    await turns.route(_state_frame())

    assert sink.closed == 0 and process.tails == 0


async def test_a_turn_the_cli_starts_on_its_own_turns_busy_on(turns_env):
    """The report of background work that ended: no one sent it, so no listener — but ``busy`` is real."""
    process, worker, lock, turns = turns_env
    worker.is_parked, worker.session_state = True, "idle"
    assert not turns.open

    worker.session_state = "running"
    await turns.route(_state_frame())

    assert turns.open and turns.sink is None
    assert lock.locked() and process._turn_in_flight and process.broadcasts == 1


async def test_deliver_turns_busy_on_before_the_message_is_written(turns_env):
    process, worker, lock, turns = turns_env
    worker.is_parked, worker.session_state = True, "idle"
    sink = _Sink()

    assert await turns.deliver("hello", sink)

    assert worker.written == ["hello"]
    assert turns.open and turns.sink is sink and lock.locked() and process._turn_in_flight


async def test_deliver_refuses_a_worker_that_is_not_parked(turns_env):
    _, worker, lock, turns = turns_env
    worker.session_state = "running"

    assert not await turns.deliver("hello", _Sink())
    assert worker.written == [] and not lock.locked()


async def test_a_failed_write_gives_the_slot_back_without_closing_the_callers_stream(turns_env):
    """The process died between the claim and the write: the caller starts a fresh worker for this
    message, so nothing may stay busy and the caller's own stream must not be ended under it."""
    process, worker, lock, turns = turns_env
    worker.is_parked, worker.session_state, worker.write_ok = True, "idle", False
    sink = _Sink()

    assert not await turns.deliver("hello", sink)

    assert sink.closed == 0 and sink.frames == []
    assert not turns.open and not lock.locked() and process.tails == 1


async def test_a_new_listener_ends_the_stream_of_the_turn_it_follows(turns_env):
    """Delivered before the previous turn's ``idle`` was handled: that turn's response must end, not hang."""
    _, worker, _, turns = turns_env
    first, second = _Sink(), _Sink()
    await turns.begin(first, announce=False)
    worker.is_parked, worker.session_state = True, "idle"

    assert await turns.deliver("next", second)

    assert first.closed == 1 and second.closed == 0 and turns.sink is second


# ── ``busy`` and the registry ────────────────────────────────────────────────────────────────


class _RegisteredWorker:
    def __init__(self, parked: bool) -> None:
        self.parked = parked


@pytest.fixture
def process():
    return AgenticProcess(id=mint_uuid(), worker_type=WorkerType.CLAUDE_CODE, pty_mode=False)


def test_a_parked_worker_is_registered_but_is_not_a_turn(process):
    worker = _RegisteredWorker(parked=True)
    register_prompt_worker(process.id, worker)
    try:
        assert prompt_worker_parked(process.id)
        assert not prompt_worker_active(process.id)
        assert not is_turn_busy(process)  # the user can type and send
        assert any_prompt_in_flight()  # but the box is still working: it stays awake
    finally:
        unregister_prompt_worker(process.id, worker)


def test_the_same_worker_is_busy_the_moment_it_is_not_parked(process):
    worker = _RegisteredWorker(parked=False)
    register_prompt_worker(process.id, worker)
    try:
        assert prompt_worker_active(process.id)
        assert is_turn_busy(process)
    finally:
        unregister_prompt_worker(process.id, worker)


async def test_a_prompt_for_a_parked_process_is_delivered_not_refused(process):
    """``prompt`` is what the queue's drain calls at a turn's end: with a worker parked it must reach THAT
    worker, not 409 because a worker is registered."""
    worker = _Worker()
    worker.is_parked, worker.session_state = True, "idle"
    process_turns = WorkerTurns(process, worker, log_prefix="t")
    register_prompt_worker(process.id, worker)
    process_turns.register()
    # ``prompt_worker_parked`` reads ``worker.parked`` off the registry.
    try:
        response = await process.prompt("what is the status")
        assert response.data["status"] == "started"
        assert worker.written and "what is the status" in worker.written[0]
        assert worker_turns_for(process.id) is process_turns
    finally:
        process_turns.discard()
        unregister_prompt_worker(process.id, worker)


class _StoppableWorker(_RegisteredWorker):
    def __init__(self, parked: bool) -> None:
        super().__init__(parked)
        self.stopped = False

    async def stop_parked(self) -> bool:
        self.stopped = True
        self.parked = False
        return True


async def test_stop_background_ends_a_parked_worker(process):
    worker = _StoppableWorker(parked=True)
    register_prompt_worker(process.id, worker)
    try:
        response = await process._http_stop_background()

        assert response.data == {"stopped": True} and worker.stopped
    finally:
        unregister_prompt_worker(process.id, worker)


async def test_stop_background_is_refused_when_nothing_is_parked(process):
    """The work may have ended on its own a moment before the click: refuse (409), stop nothing."""
    assert (await process._http_stop_background()).status_code == 409

    worker = _StoppableWorker(parked=False)  # a turn is running: that is cancel-prompt's
    register_prompt_worker(process.id, worker)
    try:
        assert (await process._http_stop_background()).status_code == 409 and not worker.stopped
    finally:
        unregister_prompt_worker(process.id, worker)


def test_the_projection_says_when_background_work_is_what_keeps_the_process_alive(process):
    """What the composer's "Background tasks" chip reads — and it must not read true for a running turn."""
    worker = _RegisteredWorker(parked=True)
    register_prompt_worker(process.id, worker)
    try:
        assert process.model_dump()["background_work"] is True
        worker.parked = False
        assert process.model_dump()["background_work"] is False
    finally:
        unregister_prompt_worker(process.id, worker)
    assert process.model_dump()["background_work"] is False
