"""run_shell_command checks that a typed ``!`` command reached Claude Code, and types it once more if not.

Claude 2.1.3xx answers every ``!`` command with a model turn and writes the turn's
transcript rows a moment late, so a command link clicked right after another one could
be typed into a TUI that was mid-answer and silently dropped (QA i16, command links
"click runs in chat"). The transcript is the proof of delivery: a ``<bash-input>`` row
(or Claude's own queue ``enqueue`` row) for the command.
"""

from __future__ import annotations

import json
import os
import time
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import agentic_process as ap_mod
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers.claude.shell_command_rows import shell_command_landed
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse


def _iso(when: datetime) -> str:
    return when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _append(path: Path, row: dict) -> None:
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")


def _bash_input(command: str, when: datetime) -> dict:
    return {"type": "user", "timestamp": _iso(when), "message": {"role": "user", "content": f"<bash-input> {command}</bash-input>"}}


def _quiet(path: Path) -> None:
    """Age the transcript so the session counts as settled."""
    old = time.time() - 60
    os.utime(path, (old, old))


# ── the transcript matcher ──────────────────────────────────────────────────────


def test_landed_reads_a_run_or_a_claude_queue_entry_made_since_the_typing(tmp_path: Path):
    path = tmp_path / "s.jsonl"
    now = datetime.now(timezone.utc)
    _append(path, _bash_input("sh mark.sh line", now - timedelta(seconds=30)))  # an earlier run
    assert not shell_command_landed(path, "sh mark.sh line", now)
    _append(path, {"type": "queue-operation", "operation": "enqueue", "timestamp": _iso(now), "content": "sh mark.sh quoted"})
    assert shell_command_landed(path, "sh mark.sh quoted", now)
    assert not shell_command_landed(path, "sh mark.sh inline", now)
    _append(path, _bash_input("sh mark.sh inline", now + timedelta(seconds=1)))
    assert shell_command_landed(path, "sh mark.sh inline", now)


def test_landed_is_false_without_a_transcript(tmp_path: Path):
    assert not shell_command_landed(tmp_path / "missing.jsonl", "ls", datetime.now(timezone.utc))


# ── run_shell_command ───────────────────────────────────────────────────────────


def _process(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, drops: int):
    """An AgenticProcess stand-in whose TUI drops the first *drops* typings of a command."""
    monkeypatch.setattr(ap_mod, "SHELL_COMMAND_ARRIVAL_TIMEOUT_S", 0.5)
    monkeypatch.setattr(ap_mod, "SHELL_COMMAND_QUIET_S", 0.2)
    monkeypatch.setattr(ap_mod, "SHELL_COMMAND_IDLE_TIMEOUT_S", 2.0)
    monkeypatch.setattr(ap_mod, "is_turn_busy", lambda _process: False)
    monkeypatch.setattr(ap_mod, "_last_shell_command", {})
    path = tmp_path / "s.jsonl"
    _append(path, {"type": "assistant", "timestamp": _iso(datetime.now(timezone.utc)), "message": {"role": "assistant"}})
    _quiet(path)
    fake = types.SimpleNamespace(
        id="agentic_process-test",
        driver=types.SimpleNamespace(pty_shell_escape="!", shell_command_landed=staticmethod(shell_command_landed)),
        transcript_path=path,
        typed=[],
        queued=[],
    )

    async def is_live():
        return True

    async def type_command(escape, command):
        fake.typed.append(command)
        if len(fake.typed) > drops:
            _append(path, _bash_input(command, datetime.now(timezone.utc)))
        _quiet(path)
        return None

    async def enqueue(prompt, *, source):
        fake.queued.append(prompt)
        return {"id": "q1"}

    fake._shell_escape = lambda: "!"
    fake._is_live_pty = is_live
    fake._type_shell_command = type_command
    fake._enqueue = enqueue
    fake._deliver_shell_command = types.MethodType(AgenticProcess._deliver_shell_command, fake)
    fake._shell_settled = types.MethodType(AgenticProcess._shell_settled, fake)
    fake._shell_command_arrived = types.MethodType(AgenticProcess._shell_command_arrived, fake)
    return fake, path


async def test_delivered_command_is_typed_once(tmp_path, monkeypatch):
    fake, _ = _process(tmp_path, monkeypatch, drops=0)
    result = await AgenticProcess.run_shell_command(fake, "sh mark.sh line")
    assert isinstance(result, ApiSuccessResponse) and result.data == {"status": "ran"}
    assert fake.typed == ["sh mark.sh line"]


async def test_dropped_command_is_typed_once_more(tmp_path, monkeypatch):
    fake, path = _process(tmp_path, monkeypatch, drops=1)
    result = await AgenticProcess.run_shell_command(fake, "sh mark.sh inline")
    assert isinstance(result, ApiSuccessResponse) and result.data == {"status": "ran"}
    assert fake.typed == ["sh mark.sh inline", "sh mark.sh inline"]
    assert shell_command_landed(path, "sh mark.sh inline", datetime.now(timezone.utc) - timedelta(minutes=1))


async def test_never_typed_a_third_time(tmp_path, monkeypatch):
    fake, _ = _process(tmp_path, monkeypatch, drops=5)
    result = await AgenticProcess.run_shell_command(fake, "sh mark.sh inline")
    assert isinstance(result, ApiFailResponse) and result.status_code == 409
    assert len(fake.typed) == 2


async def test_waits_for_a_fresh_transcript_to_settle_before_typing(tmp_path, monkeypatch):
    """Idle by the tail but just written (Claude may be about to answer): wait, then type."""
    fake, path = _process(tmp_path, monkeypatch, drops=0)
    os.utime(path, None)  # written just now
    started = time.monotonic()
    result = await AgenticProcess.run_shell_command(fake, "sh mark.sh quoted")
    assert result.data == {"status": "ran"}
    assert time.monotonic() - started >= ap_mod.SHELL_COMMAND_QUIET_S * 0.9
    assert fake.typed == ["sh mark.sh quoted"] and fake.queued == []


async def test_a_turn_that_never_ends_falls_back_to_the_queue(tmp_path, monkeypatch):
    fake, _ = _process(tmp_path, monkeypatch, drops=0)
    monkeypatch.setattr(ap_mod, "is_turn_busy", lambda _process: True)
    result = await AgenticProcess.run_shell_command(fake, "sh mark.sh quoted")
    assert result.data["status"] == "queued"
    assert fake.typed == [] and fake.queued == ["! sh mark.sh quoted"]
