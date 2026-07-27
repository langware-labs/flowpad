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
import os
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.claude import (
    CANCEL_GRACE_SECONDS,
    ClaudeCLIStreamWorker,
)
from flow_sdk.builtin.agentic_process.cli_drivers.claude.event_to_flowdata import convert_event
from flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker import (
    _TranscriptDurabilityGate,
)
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    WorkerSpawnError,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType
from tests.utils.fake_cli import (
    clear_harness_capability,
    fake_stream_argv,
    make_fake_cli_bin,
    patch_build_spawn,
    seed_harness_capability,
)

# ── Fake-claude helpers ──────────────────────────────────────────────────────


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
    "message": {
        "content": [{"type": "text", "text": "hello"}],
        # Real Claude Code 2.1.207 stream-json terminal events use null here.
        "stop_reason": None,
    },
}
ASSISTANT_MAX_TOKENS = {
    "type": "assistant",
    "message": {
        "content": [{"type": "text", "text": "partial but terminal"}],
        "stop_reason": "max_tokens",
    },
}
ASSISTANT_TOOL_USE = {
    "type": "assistant",
    "message": {
        "content": [{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "ls"}}],
        # Real tool-use events also use null; the content block distinguishes
        # them from the final text-only assistant event.
        "stop_reason": None,
    },
}
ASSISTANT_NARRATED_TOOL_USE = {
    "type": "assistant",
    "message": {
        "content": [
            {"type": "text", "text": "I will inspect it."},
            {"type": "tool_use", "id": "toolu_2", "name": "Read", "input": {"file_path": "x"}},
        ],
        "stop_reason": None,
    },
}
USER_TOOL_RESULT = {
    "type": "user",
    "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "file1\nfile2"}]},
}
RESULT_SUCCESS = {
    "type": "result",
    "subtype": "success",
    "total_cost_usd": 0.05,
    "duration_ms": 1234,
}


# ── Tests ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_full_turn_yields_correct_flowdata_sequence(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    worker = ClaudeCLIStreamWorker()
    patch_build_spawn(
        monkeypatch,
        ClaudeCLIStreamWorker,
        fake_stream_argv(
            [
                INIT_EVENT,
                ASSISTANT_TOOL_USE,
                USER_TOOL_RESULT,
                ASSISTANT_TEXT,
                RESULT_SUCCESS,
            ],
            delay_ms=10,
        ),
    )
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
    assert types.index(FlowElementType.CHAT) < types.index(FlowElementType.RESULT)
    assert types.index(FlowElementType.RESULT) < types.index(FlowElementType.END)


def test_terminal_chat_and_result_wait_for_subprocess_settlement_boundary():
    """Claude stdout assistant precedes its JSONL append; EOF is durable."""
    gate = _TranscriptDurabilityGate()
    terminal_frames = convert_event(ASSISTANT_TEXT)

    assert gate.feed(ASSISTANT_TEXT, terminal_frames) == []

    rate_limit = convert_event({"type": "rate_limit_event", "status": "allowed"})
    assert gate.feed({"type": "rate_limit_event"}, rate_limit) == []

    result_frames = convert_event(RESULT_SUCCESS)
    assert gate.feed(RESULT_SUCCESS, result_frames) == []
    drained = gate.drain()
    assert drained == terminal_frames + rate_limit + result_frames
    assert gate.drain() == []


def test_non_end_turn_terminal_reason_waits_for_settlement_boundary():
    gate = _TranscriptDurabilityGate()
    terminal_frames = convert_event(ASSISTANT_MAX_TOKENS)

    assert gate.feed(ASSISTANT_MAX_TOKENS, terminal_frames) == []
    assert gate.drain() == terminal_frames


def test_per_block_narration_released_on_continuation():
    """Streaming-input mode splits assistant messages per content block: a
    text-only narration event is shape-identical to the final answer. The gate
    holds it, then releases it live (in order) as soon as a continuation event
    (the tool_use block / a tool_result) proves the turn isn't over — live
    streaming must not buffer the whole turn until EOF."""
    gate = _TranscriptDurabilityGate()
    narration_event = {
        "type": "assistant",
        "message": {"content": [{"type": "text", "text": "I will run it."}], "stop_reason": None},
    }
    tool_use_only = {
        "type": "assistant",
        "message": {"content": [{"type": "tool_use", "id": "toolu_9", "name": "Bash", "input": {}}], "stop_reason": None},
    }
    narration_frames = convert_event(narration_event)
    tool_frames = convert_event(tool_use_only)

    assert gate.feed(narration_event, narration_frames) == []  # candidate held
    released = gate.feed(tool_use_only, tool_frames)
    assert released == narration_frames + tool_frames  # narration released live, in order

    result_frames = convert_event(RESULT_SUCCESS)
    tool_result_frames = convert_event(USER_TOOL_RESULT)
    assert gate.feed(USER_TOOL_RESULT, tool_result_frames) == tool_result_frames
    final_frames = convert_event(ASSISTANT_TEXT)
    assert gate.feed(ASSISTANT_TEXT, final_frames) == []  # real final answer held
    assert gate.feed(RESULT_SUCCESS, result_frames) == []  # result locks the hold
    assert gate.drain() == final_frames + result_frames


def test_tool_use_narration_stays_live_and_in_event_order():
    gate = _TranscriptDurabilityGate()
    frames = convert_event(ASSISTANT_NARRATED_TOOL_USE)

    emitted = gate.feed(ASSISTANT_NARRATED_TOOL_USE, frames)

    assert emitted == frames
    assert [frame.attributes["element-type"] for frame in emitted] == [
        FlowElementType.CHAT,
        FlowElementType.TOOL_CALL,
    ]
    assert gate.drain() == []


@pytest.mark.asyncio
async def test_each_stream_line_parsed_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Each stdout line is ``json.loads``-parsed exactly once. The parsed event
    dict is reused for conversion, session-id capture, and the durability gate.

    Invariant: the number of in-process ``json.loads`` calls during the turn
    equals the number of ``_stream_event`` calls (one parse per line). Any
    second parse of a line (the old ``convert_line`` + ``_extract_session_id``
    re-parses) would push ``json.loads`` above the per-line count.
    """
    import flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker as sw

    counts = {"loads": 0, "stream_event": 0}
    real_loads = json.loads
    real_stream_event = sw._stream_event

    def counting_loads(*args, **kwargs):
        counts["loads"] += 1
        return real_loads(*args, **kwargs)

    def counting_stream_event(decoded):
        counts["stream_event"] += 1
        return real_stream_event(decoded)

    monkeypatch.setattr(json, "loads", counting_loads)
    monkeypatch.setattr(sw, "_stream_event", counting_stream_event)

    worker = ClaudeCLIStreamWorker()
    patch_build_spawn(
        monkeypatch,
        ClaudeCLIStreamWorker,
        fake_stream_argv([INIT_EVENT, ASSISTANT_TOOL_USE, USER_TOOL_RESULT, ASSISTANT_TEXT, RESULT_SUCCESS], delay_ms=5),
    )
    ctx = AgenticContext(workdir=str(tmp_path))

    await _collect(worker, ctx)

    assert counts["stream_event"] >= 5  # every non-empty stdout line reached the parser
    assert counts["loads"] == counts["stream_event"]  # exactly one parse per line
    # The init line was parsed by that same single parse, not a re-parse.
    assert worker.get_session_id() == "test-session-abc"


@pytest.mark.asyncio
async def test_malformed_lines_still_yield_todays_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A non-JSON line and a valid-JSON-but-not-a-dict line each produce no
    frames (today's ``convert_line`` fallback), don't crash the turn, and don't
    stop valid events around them from converting normally."""
    lines = [
        "this is not json at all",  # non-JSON → []
        json.dumps([1, 2, 3]),      # valid JSON, not a dict → []
        json.dumps(INIT_EVENT),
        json.dumps(ASSISTANT_TEXT),
        json.dumps(RESULT_SUCCESS),
    ]
    # printf "%s\n" "$@" emits each line verbatim (no shell quoting hazards).
    argv = ["bash", "-c", 'printf "%s\\n" "$@"', "bash", *lines]
    worker = ClaudeCLIStreamWorker()
    patch_build_spawn(monkeypatch, ClaudeCLIStreamWorker, argv)
    ctx = AgenticContext(workdir=str(tmp_path))

    out = await _collect(worker, ctx)

    types = [fd.attributes["element-type"] for fd in out]
    # Valid events around the garbage still convert.
    assert FlowElementType.STATUS in types  # init
    assert FlowElementType.CHAT in types    # assistant answer
    assert FlowElementType.RESULT in types
    assert out[-1].attributes["element-type"] == FlowElementType.END
    # The garbage produced no parse-error/unknown frames — it's silently dropped.
    subtypes = [fd.attributes.get("subtype") for fd in out]
    assert "parse-error" not in subtypes
    assert "unknown" not in subtypes
    assert worker.get_session_id() == "test-session-abc"


@pytest.mark.asyncio
async def test_session_id_captured_from_init_event(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    worker = ClaudeCLIStreamWorker()
    patch_build_spawn(monkeypatch, ClaudeCLIStreamWorker, fake_stream_argv([INIT_EVENT, RESULT_SUCCESS], delay_ms=10))
    ctx = AgenticContext(workdir=str(tmp_path))

    await _collect(worker, ctx)

    assert worker.get_session_id() == "test-session-abc"


@pytest.mark.asyncio
async def test_init_without_session_id_leaves_session_unset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    worker = ClaudeCLIStreamWorker()
    patch_build_spawn(
        monkeypatch,
        ClaudeCLIStreamWorker,
        fake_stream_argv([{"type": "system", "subtype": "init"}, RESULT_SUCCESS], delay_ms=10),
    )
    ctx = AgenticContext(workdir=str(tmp_path))

    await _collect(worker, ctx)

    assert worker.get_session_id() is None


@pytest.mark.asyncio
async def test_nonzero_exit_produces_exit_error_status(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    worker = ClaudeCLIStreamWorker()
    # bash -c 'printf {init}; exit 2' → one event then exit code 2
    argv = ["bash", "-c", f"printf '%s\\n' {json.dumps(json.dumps(INIT_EVENT))}; exit 2"]
    patch_build_spawn(monkeypatch, ClaudeCLIStreamWorker, argv)
    ctx = AgenticContext(workdir=str(tmp_path))

    out = await _collect(worker, ctx)

    subtypes = [
        fd.attributes.get("subtype") for fd in out if fd.attributes.get("element-type") == FlowElementType.STATUS
    ]
    assert "exit-error" in subtypes
    # Always a final END even on error exit.
    assert out[-1].attributes["element-type"] == FlowElementType.END


@pytest.mark.asyncio
async def test_final_end_frame_always_emitted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Even when nothing is produced and the subprocess exits cleanly,
    the worker guarantees an END frame so parsers always close."""
    worker = ClaudeCLIStreamWorker()
    patch_build_spawn(monkeypatch, ClaudeCLIStreamWorker, ["bash", "-c", "true"])  # no output, exit 0
    ctx = AgenticContext(workdir=str(tmp_path))

    out = await _collect(worker, ctx)

    assert out, "expected at least the final END frame"
    assert out[-1].attributes["element-type"] == FlowElementType.END


@pytest.mark.asyncio
async def test_close_session_terminates_running_subprocess(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Kick off a long-running subprocess, call close_session, expect exit."""
    worker = ClaudeCLIStreamWorker()
    # Run forever until signalled.
    argv = ["bash", "-c", "sleep 60"]
    patch_build_spawn(monkeypatch, ClaudeCLIStreamWorker, argv)
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


GRACEFUL_FAKE_CLI = r"""
import json, sys

# First stdin line: the stream-json user message carrying the prompt.
first = json.loads(sys.stdin.readline())
assert first["type"] == "user", first
print(json.dumps({"type": "system", "subtype": "init", "session_id": "sid-graceful"}), flush=True)
print(json.dumps({"type": "assistant", "message": {
    "content": [{"type": "tool_use", "id": "toolu_g1", "name": "Bash", "input": {"command": "sleep 60"}}],
    "stop_reason": None}}), flush=True)
# Block until the interrupt control request arrives (the graceful cancel).
ctl = json.loads(sys.stdin.readline())
assert ctl["type"] == "control_request" and ctl["request"]["subtype"] == "interrupt", ctl
print(json.dumps({"type": "result", "subtype": "error_during_execution", "is_error": True}), flush=True)
# Streaming-input mode: stay alive until the worker closes stdin, then exit 0.
sys.stdin.read()
"""


@pytest.mark.asyncio
async def test_close_session_graceful_interrupt(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """The interrupt control request stops the turn without a kill: the CLI
    exits 0, the interrupted result is reclassified ``outcome=aborted``, the
    canonical turn-abort STATUS is emitted, and no ``exit-error``/ERROR frame
    appears — a user stop must not render as a crash."""
    script = tmp_path / "fake_claude_graceful.py"
    script.write_text(GRACEFUL_FAKE_CLI, encoding="utf-8")
    worker = ClaudeCLIStreamWorker()
    user_msg = json.dumps({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}}) + "\n"
    patch_build_spawn(monkeypatch, ClaudeCLIStreamWorker, ["python3", str(script)], stdin=user_msg)
    ctx = AgenticContext(workdir=str(tmp_path))

    out: list = []

    async def _run():
        async for fd in worker.execute(prompt="hi", context=ctx):
            out.append(fd)

    task = asyncio.create_task(_run())
    while not any(fd.attributes.get("element-type") == FlowElementType.TOOL_CALL for fd in out):
        await asyncio.sleep(0.02)

    await worker.close_session()
    await asyncio.wait_for(task, timeout=CANCEL_GRACE_SECONDS + 2)

    assert worker.cancelled_gracefully is True
    assert worker._proc is not None and worker._proc.returncode == 0

    results = [fd for fd in out if fd.attributes.get("element-type") == FlowElementType.RESULT]
    assert results and results[0].attributes["outcome"] == "aborted"
    assert results[0].attributes["turn-terminated"] == "true"
    subtypes = [fd.attributes.get("subtype") for fd in out]
    assert "turn_aborted" in subtypes
    assert "exit-error" not in subtypes
    assert not any(fd.attributes.get("element-type") == FlowElementType.ERROR for fd in out)
    assert out[-1].attributes["element-type"] == FlowElementType.END


@pytest.mark.asyncio
async def test_cancel_kill_path_reports_abort_not_exit_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """When the CLI has no stdin channel (escalation kill path), a requested
    cancel still classifies as turn-abort, never ``exit-error``."""
    worker = ClaudeCLIStreamWorker()
    patch_build_spawn(monkeypatch, ClaudeCLIStreamWorker, ["bash", "-c", "sleep 60"])
    ctx = AgenticContext(workdir=str(tmp_path))

    out: list = []

    async def _run():
        async for fd in worker.execute(prompt="hi", context=ctx):
            out.append(fd)

    task = asyncio.create_task(_run())
    await asyncio.sleep(0.2)
    await worker.close_session()
    await asyncio.wait_for(task, timeout=CANCEL_GRACE_SECONDS + 2)

    assert worker.cancelled_gracefully is False
    assert worker._proc is not None and worker._proc.returncode not in (0, None)
    subtypes = [fd.attributes.get("subtype") for fd in out]
    assert "turn_aborted" in subtypes
    assert "exit-error" not in subtypes
    terminated = [fd for fd in out if fd.attributes.get("turn-terminated") == "true"]
    assert terminated, "expected the canonical turn-abort STATUS frame"


@pytest.mark.asyncio
async def test_no_claude_binary_yields_error_flowdata_then_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    worker = ClaudeCLIStreamWorker()
    # No discovered harness capability value → typed spawn failure: an ERROR
    # frame for the chat stream, then WorkerSpawnError for the turn runner's
    # FAILED + start_failure latch.
    clear_harness_capability(monkeypatch, "claude")
    ctx = AgenticContext(workdir=str(tmp_path))

    out = []
    with pytest.raises(WorkerSpawnError, match=r"no harness\.claude\.cli installation discovered"):
        async for fd in worker.execute(prompt="hi", context=ctx):
            out.append(fd)

    assert len(out) == 1
    assert out[0].attributes["element-type"] == FlowElementType.ERROR


def test_build_spawn_uses_absolute_discovered_claude_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """D02 parity with codex: a backend service PATH that excludes the nvm bin
    dir must not break the spawn when discovery recorded it — argv[0] is the
    absolute discovered executable even when the context env_vars carry their
    own PATH pin (the ``apply_worker_env`` overlay)."""
    bin_dir, claude = make_fake_cli_bin(tmp_path, "claude")
    stripped = os.pathsep.join(["/usr/bin", "/bin"])
    monkeypatch.setenv("PATH", stripped)
    seed_harness_capability(monkeypatch, "claude", bin_dir)
    ctx = AgenticContext(
        workdir=str(tmp_path),
        env_vars={"PATH": f"{tmp_path / 'venv-bin'}{os.pathsep}{stripped}"},
    )

    argv, env, stdin_payload = ClaudeCLIStreamWorker()._build_spawn("hi", ctx)

    assert argv[0] == str(claude)
    assert env["PATH"].split(os.pathsep)[0] == str(bin_dir)
    # The prompt rides stdin as a stream-json user message (the open pipe is
    # the graceful-interrupt channel) — never as an argv positional.
    assert "--input-format" in argv and "stream-json" in argv
    assert "--" not in argv
    payload = json.loads(stdin_payload)
    assert payload["type"] == "user"
    assert payload["message"]["content"][0]["text"] == "hi"
