"""Unit tests for CodexCLIStreamWorker.

Mirrors ``tests/unit/test_copilot_cli_stream_worker.py`` — a fake-argv worker
whose ``_build_spawn`` is monkeypatched to a shell that ``printf``s canned
JSONL lines. No real ``codex`` binary is touched.

Two behaviours specific to codex are pinned here:

- **session-id capture from ``thread.started``** — the worker records the
  ``thread_id`` of the FIRST ``thread.started`` event onto ``self._session_id``
  (``codex/stream_worker.py`` ~:146). A second ``thread.started`` in the same
  stream does NOT overwrite it.
- **the fresh-id-every-turn hazard** — codex mints its OWN rollout id per run;
  in a headless multi-turn where no rollout persists, the driver builds a fresh
  ``CodexCLIStreamWorker`` per turn and each turn captures a DIFFERENT id. These
  tests pin that documented behaviour at the worker level (the driver's
  ``has_resumable_session`` gate is what suppresses it when a rollout survives —
  see ``tests/unit/test_cli_driver_contract.py``).
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgenticContext
from flow_sdk.builtin.agentic_process.cli_drivers.codex import (
    CANCEL_GRACE_SECONDS,
    CodexCLIStreamWorker,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType
from tests.utils.fake_cli import fake_stream_argv, patch_build_spawn

# ``_build_spawn`` takes ``(context, prompt)`` and returns a 3-tuple
# ``(argv, env, stdin)`` — codex delivers the prompt over the child's stdin
# (PROMPT_CHANNEL="stdin"). ``patch_build_spawn(..., stdin="")`` reproduces that
# 3-tuple shape; the stdin body is ignored by the bash fake.


async def _collect(worker: CodexCLIStreamWorker, context: AgenticContext) -> list:
    return [fd async for fd in worker.execute(prompt="hi", context=context)]


THREAD_STARTED = {
    "type": "thread.started",
    "thread_id": "019dddd0-1234-7000-9000-000000000001",
    "timestamp": "2026-05-06T21:39:48.000Z",
}
TURN_COMPLETED = {
    "type": "turn.completed",
    "usage": {"input_tokens": 3, "output_tokens": 5},
    "timestamp": "2026-05-06T21:39:50.000Z",
}


def test_build_spawn_uses_absolute_discovered_codex_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    bin_dir = tmp_path / "nvm-bin"
    bin_dir.mkdir()
    codex = bin_dir / "codex"
    codex.write_text("#!/bin/sh\n", encoding="utf-8")
    codex.chmod(0o755)
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.codex.stream_worker.worker_path_env",
        lambda _worker: {"PATH": str(bin_dir)},
    )

    argv, env, stdin = CodexCLIStreamWorker()._build_spawn(AgenticContext(workdir=str(tmp_path)), "hello")

    assert argv is not None and argv[0] == str(codex)
    assert env["PATH"] == str(bin_dir)
    assert stdin == "hello"


@pytest.mark.asyncio
async def test_session_id_captured_from_thread_started(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    worker = CodexCLIStreamWorker(transcript_path=tmp_path / "codex.jsonl")
    patch_build_spawn(
        monkeypatch, CodexCLIStreamWorker, fake_stream_argv([THREAD_STARTED, TURN_COMPLETED], delay_ms=2), stdin=""
    )

    await _collect(worker, AgenticContext(workdir=str(tmp_path)))

    assert worker.get_session_id() == "019dddd0-1234-7000-9000-000000000001"


@pytest.mark.asyncio
async def test_first_thread_started_wins_within_a_stream(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # The ``self._session_id is None`` guard means only the FIRST thread.started
    # sets the id; a later one in the same stream is ignored.
    second = {
        "type": "thread.started",
        "thread_id": "aaaaaaaa-0000-7000-9000-000000000002",
        "timestamp": "2026-05-06T21:39:49.000Z",
    }
    worker = CodexCLIStreamWorker(transcript_path=tmp_path / "codex.jsonl")
    patch_build_spawn(
        monkeypatch,
        CodexCLIStreamWorker,
        fake_stream_argv([THREAD_STARTED, second, TURN_COMPLETED], delay_ms=2),
        stdin="",
    )

    await _collect(worker, AgenticContext(workdir=str(tmp_path)))

    assert worker.get_session_id() == "019dddd0-1234-7000-9000-000000000001"


@pytest.mark.asyncio
async def test_fresh_id_every_turn_hazard(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # Documented hazard: with no persisted rollout, the driver builds a fresh
    # worker per turn and each turn captures whatever id its own thread.started
    # carries. Two fresh workers fed different ``thread.started`` events capture
    # two different ids — i.e. session continuity is NOT preserved by the worker
    # alone; it relies on the rollout + ``has_resumable_session`` resume gate.
    turn1_id = "019dddd0-1234-7000-9000-000000000001"
    turn2_id = "bbbbbbbb-0000-7000-9000-000000000003"

    w1 = CodexCLIStreamWorker(transcript_path=tmp_path / "t1.jsonl")
    patch_build_spawn(
        monkeypatch,
        CodexCLIStreamWorker,
        fake_stream_argv([{**THREAD_STARTED, "thread_id": turn1_id}, TURN_COMPLETED], delay_ms=2),
        stdin="",
    )
    await _collect(w1, AgenticContext(workdir=str(tmp_path)))

    w2 = CodexCLIStreamWorker(transcript_path=tmp_path / "t2.jsonl")
    patch_build_spawn(
        monkeypatch,
        CodexCLIStreamWorker,
        fake_stream_argv([{**THREAD_STARTED, "thread_id": turn2_id}, TURN_COMPLETED], delay_ms=2),
        stdin="",
    )
    await _collect(w2, AgenticContext(workdir=str(tmp_path)))

    assert w1.get_session_id() == turn1_id
    assert w2.get_session_id() == turn2_id
    assert w1.get_session_id() != w2.get_session_id()


@pytest.mark.asyncio
async def test_turn_completed_yields_result_and_end(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    worker = CodexCLIStreamWorker(transcript_path=tmp_path / "codex.jsonl")
    patch_build_spawn(
        monkeypatch, CodexCLIStreamWorker, fake_stream_argv([THREAD_STARTED, TURN_COMPLETED], delay_ms=2), stdin=""
    )

    out = await _collect(worker, AgenticContext(workdir=str(tmp_path)))
    types = [fd.attributes["element-type"] for fd in out]

    assert FlowElementType.RESULT in types
    assert types[-1] == FlowElementType.END


@pytest.mark.asyncio
async def test_stream_is_teed_to_transcript(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    transcript = tmp_path / "codex.jsonl"
    worker = CodexCLIStreamWorker(transcript_path=transcript)
    patch_build_spawn(
        monkeypatch, CodexCLIStreamWorker, fake_stream_argv([THREAD_STARTED, TURN_COMPLETED], delay_ms=2), stdin=""
    )

    await _collect(worker, AgenticContext(workdir=str(tmp_path)))

    text = transcript.read_text(encoding="utf-8")
    assert '"type": "thread.started"' in text
    assert '"type": "turn.completed"' in text
    assert worker.manages_history() is True


@pytest.mark.asyncio
async def test_missing_binary_yields_single_error_no_end(tmp_path: Path):
    # Unlike the copilot worker (which emits ERROR + END), the codex worker
    # yields ONLY the ERROR frame on a missing binary and returns early — pin
    # that divergence so a future refactor doesn't silently change the contract.
    worker = CodexCLIStreamWorker(transcript_path=tmp_path / "codex.jsonl")

    def _stub(context: AgenticContext, prompt: str):
        return None, {}, prompt

    worker._build_spawn = _stub  # type: ignore[assignment]

    out = await _collect(worker, AgenticContext(workdir=str(tmp_path)))
    types = [fd.attributes["element-type"] for fd in out]

    assert types == [FlowElementType.ERROR]
    assert "codex binary not found" in out[0].flow_value


@pytest.mark.asyncio
async def test_nonzero_exit_yields_status_and_end(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    worker = CodexCLIStreamWorker(transcript_path=tmp_path / "codex.jsonl")
    patch_build_spawn(monkeypatch, CodexCLIStreamWorker, ["bash", "-c", "printf 'boom\\n' >&2; exit 3"], stdin="")

    out = await _collect(worker, AgenticContext(workdir=str(tmp_path)))

    assert any(fd.attributes.get("subtype") == "exit-error" for fd in out)
    assert out[-1].attributes["element-type"] == FlowElementType.END


@pytest.mark.asyncio
async def test_close_session_terminates_running_worker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    worker = CodexCLIStreamWorker(transcript_path=tmp_path / "codex.jsonl")
    patch_build_spawn(monkeypatch, CodexCLIStreamWorker, ["bash", "-c", "sleep 60"], stdin="")
    ctx = AgenticContext(workdir=str(tmp_path))

    async def _run():
        async for _fd in worker.execute(prompt="hi", context=ctx):
            pass

    task = asyncio.create_task(_run())
    await asyncio.sleep(0.2)
    await worker.close_session()
    # The subprocess is terminated → stdout closes → the stream drains cleanly
    # and yields its terminal END frame within the cancel grace.
    await asyncio.wait_for(task, timeout=CANCEL_GRACE_SECONDS + 2)

    assert worker._proc is not None and worker._proc.returncode is not None
