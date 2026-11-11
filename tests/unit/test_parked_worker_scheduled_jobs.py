"""A print-mode worker stays alive while the CLI's own scheduler holds a job for it.

``CronCreate`` jobs and ``ScheduleWakeup`` wakeups fire only while the ``claude`` process
lives, and ``background_tasks_changed`` never lists them — so a worker that closed stdin at
the first ``idle`` killed every scheduled job with its process (the hourly check that fired
once and never again, 2026-10-15). The worker tracks them from the tool calls instead:

* ``CronCreate`` success → a job (keyed by the CLI's job id); ``CronDelete`` success → gone;
* a fire is a turn the scheduler starts (``command_lifecycle``) and names no job, so a
  one-shot is gone once its ``nextFireAt`` has passed, a wakeup once its ``scheduledFor`` has;
* ``--resume`` restores the session's jobs without announcing them, so a resumed worker reads
  them from the transcript (``restored_cron_jobs``).
"""

from __future__ import annotations

import json
import sys
import textwrap
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.claude import ClaudeCLIStreamWorker, stream_worker
from flow_sdk.builtin.agentic_process.cli_drivers.claude.claude_cron_job import restored_cron_jobs
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgenticContext
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData, FlowElementType
from tests.utils.fake_cli import patch_build_spawn

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


# ── a CLI with a scheduler, shaped like claude -p 2.1.303 (probed 2026-10-19) ─────────────────

FAKE_CLAUDE = textwrap.dedent(
    """
    import json, sys, threading, time

    lock = threading.Lock()

    def emit(event):
        with lock:
            print(json.dumps(event), flush=True)

    def state(name):
        emit({"type": "system", "subtype": "session_state_changed", "state": name})

    def say(text):
        emit({"type": "assistant", "message": {"content": [{"type": "text", "text": text}], "stop_reason": None}})
        emit({"type": "result", "subtype": "success", "total_cost_usd": 0.0, "duration_ms": 1})

    def call(tool_id, name, args, result, is_error=False):
        emit({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": tool_id, "name": name, "input": args}], "stop_reason": "tool_use"}})
        emit({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": tool_id, "content": "ok", "is_error": is_error}]},
            "tool_use_result": result})

    def fire_after(seconds, text):
        # The scheduler's own turn: no stdin message, wrapped in command_lifecycle.
        def run():
            time.sleep(seconds)
            state("running")
            emit({"type": "command_lifecycle", "command_uuid": text, "state": "started"})
            say(text)
            emit({"type": "command_lifecycle", "command_uuid": text, "state": "completed"})
            state("idle")
        threading.Thread(target=run, daemon=True).start()

    for line in sys.stdin:
        message = json.loads(line)
        if message.get("type") != "user":
            continue
        verb, *rest = message["message"]["content"][0]["text"].split()
        state("running")
        now_ms = time.time() * 1000
        if verb == "cron-hourly":
            call("t1", "CronCreate", {"cron": "0 * * * *", "prompt": "check", "recurring": True},
                 {"id": "c1", "recurring": True, "durable": False, "nextFireAt": now_ms + 3600_000})
        elif verb == "cron-once":
            delay = float(rest[0])
            call("t2", "CronCreate", {"cron": "* * * * *", "prompt": "once", "recurring": False},
                 {"id": "c2", "recurring": False, "durable": False, "nextFireAt": now_ms + delay * 1000})
            fire_after(delay + 0.3, "fired")
        elif verb == "cron-fails":
            call("t3", "CronCreate", {"cron": "bad"}, {}, is_error=True)
        elif verb == "delete":
            call("t4", "CronDelete", {"id": rest[0]}, {"id": rest[0]})
        elif verb == "wakeup":
            delay = float(rest[0])
            call("t5", "ScheduleWakeup", {"delaySeconds": delay, "prompt": "wake", "reason": "probe"},
                 {"scheduledFor": now_ms + delay * 1000, "clampedDelaySeconds": delay, "wasClamped": False})
            fire_after(delay + 0.3, "woke")
        elif verb == "wakeup-stop":
            call("t6", "ScheduleWakeup", {"stop": True}, {})
        say(verb)
        state("idle")
    """
)


def _user_message(text: str) -> str:
    return json.dumps({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}}) + "\n"


@pytest.fixture
def scheduler_cli(monkeypatch, tmp_path: Path):
    """``start(first_message)`` → (worker, context) whose CLI is the fake above."""
    script = tmp_path / "fake_claude.py"
    script.write_text(FAKE_CLAUDE, encoding="utf-8")

    def start(first_message: str) -> tuple[ClaudeCLIStreamWorker, AgenticContext]:
        patch_build_spawn(
            monkeypatch, ClaudeCLIStreamWorker, [sys.executable, str(script)], stdin=_user_message(first_message)
        )
        return ClaudeCLIStreamWorker(), AgenticContext(workdir=str(tmp_path))

    return start


def _chat_texts(frames: list[FlowData]) -> list[str]:
    return [str(f.flow_value) for f in frames if f.attributes.get("element-type") == FlowElementType.CHAT]


async def _send(worker: ClaudeCLIStreamWorker, text: str) -> None:
    assert worker.claim_for_message()
    assert await worker.write_user_message(text)


async def test_a_recurring_cron_job_keeps_the_worker_parked_until_it_is_deleted(scheduler_cli):
    worker, context = scheduler_cli("cron-hourly")
    frames: list[FlowData] = []
    parked_on_job = False

    async for fd in worker.execute(prompt="cron-hourly", context=context):
        frames.append(fd)
        if worker.parked and not parked_on_job:
            parked_on_job = True
            await _send(worker, "delete c1")

    assert parked_on_job, "stdin was closed at the first idle — the job died with the process"
    assert _chat_texts(frames) == ["cron-hourly", "delete"]
    assert worker._proc.returncode == 0


async def test_a_one_shot_job_keeps_the_worker_until_it_fires_then_the_process_exits(scheduler_cli):
    worker, context = scheduler_cli("cron-once 0.5")
    frames = []
    was_parked = False
    async for fd in worker.execute(prompt="cron-once 0.5", context=context):
        frames.append(fd)
        was_parked = was_parked or worker.parked

    assert was_parked
    assert _chat_texts(frames) == ["cron-once", "fired"], "the fire never ran — the process exited before it"
    assert worker._proc.returncode == 0


async def test_a_failed_cron_create_does_not_keep_the_worker(scheduler_cli):
    worker, context = scheduler_cli("cron-fails")
    frames = [fd async for fd in worker.execute(prompt="cron-fails", context=context)]

    assert _chat_texts(frames) == ["cron-fails"]
    assert worker._proc.returncode == 0


async def test_a_pending_wakeup_keeps_the_worker_until_it_fires(scheduler_cli):
    worker, context = scheduler_cli("wakeup 0.5")
    frames = []
    was_parked = False
    async for fd in worker.execute(prompt="wakeup 0.5", context=context):
        frames.append(fd)
        was_parked = was_parked or worker.parked

    assert was_parked
    assert _chat_texts(frames) == ["wakeup", "woke"]


async def test_a_wakeup_stopped_with_stop_true_releases_the_worker(scheduler_cli):
    worker, context = scheduler_cli("wakeup 60")
    frames: list[FlowData] = []
    stopped = False
    async for fd in worker.execute(prompt="wakeup 60", context=context):
        frames.append(fd)
        if worker.parked and not stopped:
            stopped = True
            await _send(worker, "wakeup-stop")

    assert stopped
    assert _chat_texts(frames) == ["wakeup", "wakeup-stop"]


async def test_stopping_a_worker_parked_on_a_cron_job_ends_it(scheduler_cli):
    worker, context = scheduler_cli("cron-hourly")
    stopped: list[bool] = []
    async for _ in worker.execute(prompt="cron-hourly", context=context):
        if worker.parked and not stopped:
            stopped.append(await worker.stop_parked())

    assert stopped == [True]
    assert worker._proc.returncode is not None


# ── resume: the jobs the CLI restores, read from the transcript ───────────────────────────────


def _stamp(at: datetime) -> str:
    return at.isoformat().replace("+00:00", "Z")


def _create(tool_id: str, job_id: str, *, recurring: bool, next_fire_at: datetime, at: datetime) -> list[dict]:
    return [
        {
            "type": "assistant",
            "timestamp": _stamp(at),
            "message": {
                "content": [{"type": "tool_use", "id": tool_id, "name": "CronCreate", "input": {"cron": "0 * * * *"}}]
            },
        },
        {
            "type": "user",
            "timestamp": _stamp(at),
            "message": {"content": [{"type": "tool_result", "tool_use_id": tool_id, "content": "Scheduled"}]},
            "toolUseResult": {
                "id": job_id,
                "recurring": recurring,
                "durable": False,
                "nextFireAt": next_fire_at.timestamp() * 1000,
            },
        },
    ]


def _delete(tool_id: str, job_id: str, *, at: datetime) -> list[dict]:
    return [
        {
            "type": "assistant",
            "timestamp": _stamp(at),
            "message": {
                "content": [{"type": "tool_use", "id": tool_id, "name": "CronDelete", "input": {"id": job_id}}]
            },
        },
        {
            "type": "user",
            "timestamp": _stamp(at),
            "message": {
                "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": f"Cancelled job {job_id}."}]
            },
            "toolUseResult": {"id": job_id},
        },
    ]


def _transcript(tmp_path: Path, entries: list[dict]) -> Path:
    path = tmp_path / "session.jsonl"
    path.write_text("\n".join(json.dumps(e) for e in entries) + "\n", encoding="utf-8")
    return path


def test_the_restored_jobs_follow_the_clis_own_restore_rule(tmp_path):
    """Created and not deleted, minus an expired recurring job and a one-shot whose time has passed."""
    now = datetime.now(timezone.utc)
    hour = timedelta(hours=1)
    path = _transcript(
        tmp_path,
        _create("t1", "live-hourly", recurring=True, next_fire_at=now + hour, at=now - hour)
        + _create("t2", "past-once", recurring=False, next_fire_at=now - hour, at=now - 2 * hour)
        + _create("t3", "future-once", recurring=False, next_fire_at=now + hour, at=now - hour)
        + _create("t4", "deleted", recurring=True, next_fire_at=now + hour, at=now - hour)
        + _delete("t5", "deleted", at=now - hour / 2)
        + _create("t6", "expired", recurring=True, next_fire_at=now + hour, at=now - timedelta(days=8)),
    )

    assert set(restored_cron_jobs(path, now.timestamp())) == {"live-hourly", "future-once"}


async def test_a_resumed_worker_stays_parked_for_the_jobs_the_cli_restored(scheduler_cli, monkeypatch, tmp_path):
    """The new process never announces a restored job; the worker reads it from the session's transcript."""
    now = datetime.now(timezone.utc)
    path = _transcript(tmp_path, _create("t1", "c1", recurring=True, next_fire_at=now + timedelta(hours=1), at=now))
    monkeypatch.setattr(stream_worker, "get_session_jsonl_path", lambda session_id, project_path=None: path)
    worker, context = scheduler_cli("hello")
    context.resume_session_id = "resumed-session"
    frames: list[FlowData] = []
    parked = False

    async for fd in worker.execute(prompt="hello", context=context):
        frames.append(fd)
        if worker.parked and not parked:
            parked = True
            await _send(worker, "delete c1")

    assert parked, "the restored job did not keep the worker"
    assert _chat_texts(frames) == ["hello", "delete"]


async def test_a_fresh_session_restores_nothing(scheduler_cli, monkeypatch):
    def unexpected(*_args, **_kwargs):
        raise AssertionError("a fresh session has no transcript to read")

    monkeypatch.setattr(stream_worker, "get_session_jsonl_path", unexpected)
    worker, context = scheduler_cli("hello")
    frames = [fd async for fd in worker.execute(prompt="hello", context=context)]

    assert _chat_texts(frames) == ["hello"]
    assert worker._proc.returncode == 0
