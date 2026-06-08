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


def _fake_copilot_argv(lines: list[dict], delay_ms: int = 5) -> list[str]:
    pieces: list[str] = []
    for obj in lines:
        pieces.append(f"printf '%s\\n' {json.dumps(json.dumps(obj))}")
        if delay_ms > 0:
            pieces.append(f"sleep {delay_ms / 1000:.3f}")
    return ["bash", "-c", "; ".join(pieces)]


def _patch_spawn(worker: CopilotCLIStreamWorker, argv: list[str], env: dict | None = None) -> None:
    def _stub(context: AgenticContext):
        return argv, (env or {})

    worker._build_spawn = _stub  # type: ignore[assignment]


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
async def test_session_id_captured_from_result(tmp_path: Path):
    worker = CopilotCLIStreamWorker(transcript_path=tmp_path / "copilot.jsonl")
    _patch_spawn(worker, _fake_copilot_argv([RESULT_SUCCESS]))

    await _collect(worker, AgenticContext(workdir=str(tmp_path)))

    assert worker.get_session_id() == "copilot-session"


@pytest.mark.asyncio
async def test_result_yields_result_and_end(tmp_path: Path):
    worker = CopilotCLIStreamWorker(transcript_path=tmp_path / "copilot.jsonl")
    _patch_spawn(worker, _fake_copilot_argv([RESULT_SUCCESS]))

    out = await _collect(worker, AgenticContext(workdir=str(tmp_path)))
    types = [fd.attributes["element-type"] for fd in out]

    assert FlowElementType.RESULT in types
    assert types[-1] == FlowElementType.END


@pytest.mark.asyncio
async def test_nonzero_exit_writes_synthetic_error(tmp_path: Path):
    transcript = tmp_path / "copilot.jsonl"
    worker = CopilotCLIStreamWorker(transcript_path=transcript)
    _patch_spawn(worker, ["bash", "-c", "printf 'bad model\\n' >&2; exit 1"])

    out = await _collect(worker, AgenticContext(workdir=str(tmp_path)))

    assert any(fd.attributes["element-type"] == FlowElementType.ERROR for fd in out)
    assert '"type":"flowpad.error"' in transcript.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_missing_binary_writes_terminal_error(tmp_path: Path):
    transcript = tmp_path / "copilot.jsonl"
    worker = CopilotCLIStreamWorker(transcript_path=transcript)
    _patch_spawn(worker, None)  # type: ignore[arg-type]

    out = await _collect(worker, AgenticContext(workdir=str(tmp_path), session_id="missing-bin"))
    types = [fd.attributes["element-type"] for fd in out]

    assert types == [FlowElementType.ERROR, FlowElementType.END]
    text = transcript.read_text(encoding="utf-8")
    assert '"type":"flowpad.error"' in text
    assert "copilot binary not found" in text


@pytest.mark.asyncio
async def test_close_session_terminates_and_writes_interrupted(tmp_path: Path):
    transcript = tmp_path / "copilot.jsonl"
    worker = CopilotCLIStreamWorker(transcript_path=transcript)
    _patch_spawn(worker, ["bash", "-c", "sleep 60"])
    ctx = AgenticContext(workdir=str(tmp_path))

    async def _run():
        async for _fd in worker.execute(prompt="hi", context=ctx):
            pass

    task = asyncio.create_task(_run())
    await asyncio.sleep(0.2)
    await worker.close_session()
    await asyncio.wait_for(task, timeout=CANCEL_GRACE_SECONDS + 2)

    assert '"type":"flowpad.interrupted"' in transcript.read_text(encoding="utf-8")
