"""Unit tests for ClaudeCLIStreamWorker — print-mode subprocess streaming.

Strategy: replace ``_build_spawn`` to return a shell command (``bash -c '…'``)
that emits a canned sequence of stream-json lines with small sleeps between
them, so we're exercising the real ``asyncio.create_subprocess_exec`` + pipe +
line-iteration + converter path — but with deterministic output instead of a
real Claude CLI.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgenticContext
from flow_sdk.builtin.agentic_process.cli_drivers.claude import (
    CANCEL_GRACE_SECONDS,
    ClaudeCLIStreamWorker,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType


# ── Fake-claude helpers ──────────────────────────────────────────────────────


def _fake_claude_argv(lines: list[dict], delay_ms: int = 10) -> list[str]:
    """Build a ``bash -c`` argv that emits ``lines`` as stream-json with delays."""
    pieces: list[str] = []
    for obj in lines:
        pieces.append(f"printf '%s\\n' {json.dumps(json.dumps(obj))}")
        if delay_ms > 0:
            pieces.append(f"sleep {delay_ms / 1000:.3f}")
    return ["bash", "-c", "; ".join(pieces)]


def _patch_spawn(worker: ClaudeCLIStreamWorker, argv: list[str], env: dict | None = None) -> None:
    """Monkey-patch the worker's ``_build_spawn`` for deterministic input."""
    def _stub(prompt: str, context: AgenticContext):
        return argv, (env or {})
    worker._build_spawn = _stub  # type: ignore[assignment]


async def _collect(worker: ClaudeCLIStreamWorker, context: AgenticContext) -> list:
    return [fd async for fd in worker.execute(prompt="hi", context=context)]


# ── Fixtures — canned claude stream-json events ──────────────────────────────


INIT_EVENT = {
    "type": "system",
    "subtype": "init",
    "session_id": "test-session-abc",
}
ASSISTANT_TEXT = {
    "type": "assistant",
    "message": {"content": [{"type": "text", "text": "hello"}]},
}
ASSISTANT_TOOL_USE = {
    "type": "assistant",
    "message": {
        "content": [
            {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "ls"}}
        ]
    },
}
USER_TOOL_RESULT = {
    "type": "user",
    "message": {
        "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": "file1\nfile2"}
        ]
    },
}
RESULT_SUCCESS = {
    "type": "result",
    "subtype": "success",
    "total_cost_usd": 0.05,
    "duration_ms": 1234,
}


# ── Tests ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_full_turn_yields_correct_flowdata_sequence(tmp_path: Path):
    worker = ClaudeCLIStreamWorker()
    _patch_spawn(worker, _fake_claude_argv([
        INIT_EVENT,
        ASSISTANT_TOOL_USE,
        USER_TOOL_RESULT,
        ASSISTANT_TEXT,
        RESULT_SUCCESS,
    ]))
    ctx = AgenticContext(workdir=str(tmp_path))

    out = await _collect(worker, ctx)

    types = [fd.attributes["element-type"] for fd in out]
    # Expected: STATUS(init) → TOOL_CALL → TOOL_RESULT → CHAT → RESULT → END → END
    # The trailing second END is emitted by the worker itself on subprocess exit;
    # the first END was emitted by convert_event for the result frame. That's
    # an acceptable duplicate — consumers dedupe or ignore repeat end markers.
    assert FlowElementType.STATUS in types
    assert FlowElementType.TOOL_CALL in types
    assert FlowElementType.TOOL_RESULT in types
    assert FlowElementType.CHAT in types
    assert FlowElementType.RESULT in types
    assert types.count(FlowElementType.END) >= 1

    # Ordering: STATUS init first, RESULT before END.
    assert types.index(FlowElementType.STATUS) < types.index(FlowElementType.TOOL_CALL)
    assert types.index(FlowElementType.RESULT) < types.index(FlowElementType.END)


@pytest.mark.asyncio
async def test_session_id_captured_from_init_event(tmp_path: Path):
    worker = ClaudeCLIStreamWorker()
    _patch_spawn(worker, _fake_claude_argv([INIT_EVENT, RESULT_SUCCESS]))
    ctx = AgenticContext(workdir=str(tmp_path))

    await _collect(worker, ctx)

    assert worker.get_session_id() == "test-session-abc"


@pytest.mark.asyncio
async def test_init_without_session_id_leaves_session_unset(tmp_path: Path):
    worker = ClaudeCLIStreamWorker()
    _patch_spawn(worker, _fake_claude_argv([{"type": "system", "subtype": "init"}, RESULT_SUCCESS]))
    ctx = AgenticContext(workdir=str(tmp_path))

    await _collect(worker, ctx)

    assert worker.get_session_id() is None


@pytest.mark.asyncio
async def test_nonzero_exit_produces_exit_error_status(tmp_path: Path):
    worker = ClaudeCLIStreamWorker()
    # bash -c 'printf {init}; exit 2' → one event then exit code 2
    argv = ["bash", "-c", f"printf '%s\\n' {json.dumps(json.dumps(INIT_EVENT))}; exit 2"]
    _patch_spawn(worker, argv)
    ctx = AgenticContext(workdir=str(tmp_path))

    out = await _collect(worker, ctx)

    subtypes = [fd.attributes.get("subtype") for fd in out if fd.attributes.get("element-type") == FlowElementType.STATUS]
    assert "exit-error" in subtypes
    # Always a final END even on error exit.
    assert out[-1].attributes["element-type"] == FlowElementType.END


@pytest.mark.asyncio
async def test_final_end_frame_always_emitted(tmp_path: Path):
    """Even when nothing is produced and the subprocess exits cleanly,
    the worker guarantees an END frame so parsers always close."""
    worker = ClaudeCLIStreamWorker()
    _patch_spawn(worker, ["bash", "-c", "true"])  # no output, exit 0
    ctx = AgenticContext(workdir=str(tmp_path))

    out = await _collect(worker, ctx)

    assert out, "expected at least the final END frame"
    assert out[-1].attributes["element-type"] == FlowElementType.END


@pytest.mark.asyncio
async def test_close_session_terminates_running_subprocess(tmp_path: Path):
    """Kick off a long-running subprocess, call close_session, expect exit."""
    worker = ClaudeCLIStreamWorker()
    # Run forever until signalled.
    argv = ["bash", "-c", "sleep 60"]
    _patch_spawn(worker, argv)
    ctx = AgenticContext(workdir=str(tmp_path))

    async def _run():
        # Drain execute() — will block on the sleep.
        async for _fd in worker.execute(prompt="hi", context=ctx):
            pass

    task = asyncio.create_task(_run())
    # Give the subprocess a beat to spawn.
    await asyncio.sleep(0.2)
    assert worker._proc is not None and worker._proc.returncode is None

    await worker.close_session()
    await asyncio.wait_for(task, timeout=CANCEL_GRACE_SECONDS + 2)

    assert worker._proc is not None
    assert worker._proc.returncode is not None  # exited


@pytest.mark.asyncio
async def test_no_claude_binary_yields_error_flowdata(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    worker = ClaudeCLIStreamWorker()
    # Force shutil.which to return None so _build_spawn decides no binary.
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker.shutil.which",
        lambda _name: None,
    )
    ctx = AgenticContext(workdir=str(tmp_path))

    out = await _collect(worker, ctx)

    assert len(out) == 1
    assert out[0].attributes["element-type"] == FlowElementType.ERROR
