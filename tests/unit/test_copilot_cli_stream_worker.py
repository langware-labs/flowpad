"""Unit tests for CopilotCLIStreamWorker."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgenticContext
from flow_sdk.builtin.agentic_process.cli_drivers.copilot import (
    CANCEL_GRACE_SECONDS,
    CopilotCLIStreamWorker,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType
from tests.utils.fake_cli import fake_stream_argv, patch_build_spawn

# ``_build_spawn`` takes ``(context, prompt)`` and returns a 3-tuple
# ``(argv, env, stdin)`` — copilot delivers the prompt over the child's stdin
# (commit 85ec7bb6, unified WorkerCLIOptions). ``patch_build_spawn(..., stdin="")``
# reproduces that 3-tuple shape; the stdin body is ignored by the bash fake.


async def _collect(worker: CopilotCLIStreamWorker, context: AgenticContext) -> list:
    return [fd async for fd in worker.execute(prompt="hi", context=context)]


RESULT_SUCCESS = {
    "type": "result",
    "timestamp": "2026-06-06T18:45:21.532Z",
    "sessionId": "copilot-session",
    "exitCode": 0,
    "usage": {"premiumRequests": 0.33},
}


@pytest.mark.asyncio
async def test_session_id_captured_from_result(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    worker = CopilotCLIStreamWorker(transcript_path=tmp_path / "copilot.jsonl")
    patch_build_spawn(monkeypatch, CopilotCLIStreamWorker, fake_stream_argv([RESULT_SUCCESS], delay_ms=5), stdin="")

    await _collect(worker, AgenticContext(workdir=str(tmp_path)))

    assert worker.get_session_id() == "copilot-session"


@pytest.mark.asyncio
async def test_result_yields_result_and_end(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    worker = CopilotCLIStreamWorker(transcript_path=tmp_path / "copilot.jsonl")
    patch_build_spawn(monkeypatch, CopilotCLIStreamWorker, fake_stream_argv([RESULT_SUCCESS], delay_ms=5), stdin="")

    out = await _collect(worker, AgenticContext(workdir=str(tmp_path)))
    types = [fd.attributes["element-type"] for fd in out]

    assert FlowElementType.RESULT in types
    assert types[-1] == FlowElementType.END


@pytest.mark.asyncio
async def test_single_jsonl_event_larger_than_asyncio_default_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    oversized_result = {**RESULT_SUCCESS, "payload": "x" * (96 * 1024)}
    assert len(json.dumps(oversized_result).encode("utf-8")) > 64 * 1024

    worker = CopilotCLIStreamWorker(transcript_path=tmp_path / "copilot.jsonl")
    patch_build_spawn(
        monkeypatch,
        CopilotCLIStreamWorker,
        fake_stream_argv([oversized_result], delay_ms=5),
        stdin="",
    )

    out = await _collect(worker, AgenticContext(workdir=str(tmp_path)))
    types = [fd.attributes["element-type"] for fd in out]

    assert worker.get_session_id() == "copilot-session"
    assert FlowElementType.RESULT in types
    assert types[-1] == FlowElementType.END


@pytest.mark.asyncio
async def test_nonzero_exit_writes_synthetic_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    transcript = tmp_path / "copilot.jsonl"
    worker = CopilotCLIStreamWorker(transcript_path=transcript)
    patch_build_spawn(monkeypatch, CopilotCLIStreamWorker, ["bash", "-c", "printf 'bad model\\n' >&2; exit 1"], stdin="")

    out = await _collect(worker, AgenticContext(workdir=str(tmp_path)))

    assert any(fd.attributes["element-type"] == FlowElementType.ERROR for fd in out)
    assert '"type":"flowpad.error"' in transcript.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_missing_binary_writes_terminal_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    transcript = tmp_path / "copilot.jsonl"
    worker = CopilotCLIStreamWorker(transcript_path=transcript)
    patch_build_spawn(monkeypatch, CopilotCLIStreamWorker, None, stdin="")  # type: ignore[arg-type]

    out = await _collect(worker, AgenticContext(workdir=str(tmp_path), session_id="missing-bin"))
    types = [fd.attributes["element-type"] for fd in out]

    assert types == [FlowElementType.ERROR, FlowElementType.END]
    text = transcript.read_text(encoding="utf-8")
    assert '"type":"flowpad.error"' in text
    assert "copilot binary not found" in text


@pytest.mark.asyncio
async def test_close_session_terminates_and_writes_interrupted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    transcript = tmp_path / "copilot.jsonl"
    worker = CopilotCLIStreamWorker(transcript_path=transcript)
    patch_build_spawn(monkeypatch, CopilotCLIStreamWorker, ["bash", "-c", "sleep 60"], stdin="")
    ctx = AgenticContext(workdir=str(tmp_path))

    async def _run():
        async for _fd in worker.execute(prompt="hi", context=ctx):
            pass

    task = asyncio.create_task(_run())
    await asyncio.sleep(0.2)
    await worker.close_session()
    await asyncio.wait_for(task, timeout=CANCEL_GRACE_SECONDS + 2)

    assert '"type":"flowpad.interrupted"' in transcript.read_text(encoding="utf-8")
