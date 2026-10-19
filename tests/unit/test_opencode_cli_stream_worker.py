"""OpenCodeCLIStreamWorker — the real subprocess/pipe/converter path.

Uses the shared fake-CLI scaffolding so the genuine spawn seam is exercised
without a real ``opencode`` binary.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    WorkerSpawnError,
)
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.stream_worker import (
    OpenCodeCLIStreamWorker,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType
from tests.utils.fake_cli import (
    clear_harness_capability,
    fake_stream_argv,
    make_fake_cli_bin,
    patch_build_spawn,
    seed_harness_capability,
)

SESSION = "ses_00f358da4ffei1Vz0U3dkTMQYX"


def _step_start() -> dict:
    return {
        "type": "step_start",
        "timestamp": 1,
        "sessionID": SESSION,
        "part": {"id": "prt_1", "messageID": "msg_1", "sessionID": SESSION, "type": "step-start"},
    }


def _text(text: str = "hello there") -> dict:
    return {
        "type": "text",
        "timestamp": 2,
        "sessionID": SESSION,
        "part": {"id": "prt_2", "messageID": "msg_1", "type": "text", "text": text},
    }


def _step_finish(reason: str = "stop") -> dict:
    return {
        "type": "step_finish",
        "timestamp": 3,
        "sessionID": SESSION,
        "part": {
            "id": "prt_3",
            "messageID": "msg_1",
            "type": "step-finish",
            "reason": reason,
            "tokens": {"input": 100, "output": 8, "reasoning": 0, "cache": {"read": 0, "write": 0}},
            "cost": 0.0012,
        },
    }


async def _drain(worker: OpenCodeCLIStreamWorker, prompt: str = "hi") -> list:
    context = AgenticContext(workdir=".", env_vars={})
    return [fd async for fd in worker.execute(prompt=prompt, context=context)]


@pytest.mark.asyncio
async def test_session_id_captured_from_first_step_start(monkeypatch, tmp_path):
    worker = OpenCodeCLIStreamWorker(transcript_path=tmp_path / "tee.jsonl")
    patch_build_spawn(
        monkeypatch,
        OpenCodeCLIStreamWorker,
        fake_stream_argv([_step_start(), _text(), _step_finish()]),
    )
    await _drain(worker)
    assert worker.get_session_id() == SESSION


@pytest.mark.asyncio
async def test_user_prompt_is_written_into_the_tee(monkeypatch, tmp_path):
    """opencode never prints the user's message (#29997), so the worker records
    it — otherwise ``transcript/prompts`` is empty for every headless turn."""
    tee = tmp_path / "tee.jsonl"
    worker = OpenCodeCLIStreamWorker(transcript_path=tee)
    patch_build_spawn(
        monkeypatch, OpenCodeCLIStreamWorker, fake_stream_argv([_step_start(), _text(), _step_finish()])
    )
    await _drain(worker, prompt="do the thing")

    first = json.loads(tee.read_text(encoding="utf-8").splitlines()[0])
    assert first["type"] == "flowpad.user_prompt"
    assert first["part"]["text"] == "do the thing"


@pytest.mark.asyncio
async def test_stream_lines_are_teed_verbatim(monkeypatch, tmp_path):
    tee = tmp_path / "tee.jsonl"
    worker = OpenCodeCLIStreamWorker(transcript_path=tee)
    patch_build_spawn(
        monkeypatch, OpenCodeCLIStreamWorker, fake_stream_argv([_step_start(), _text(), _step_finish()])
    )
    await _drain(worker)

    types = [json.loads(line)["type"] for line in tee.read_text(encoding="utf-8").splitlines()]
    assert types == ["flowpad.user_prompt", "step_start", "text", "step_finish"]


@pytest.mark.asyncio
async def test_clean_exit_without_step_finish_gets_a_synthetic_terminal(monkeypatch, tmp_path):
    """Upstream #26855: a successful turn can exit before its final
    ``step_finish``. Termination is driven by EOF on stdout — no added wait."""
    tee = tmp_path / "tee.jsonl"
    worker = OpenCodeCLIStreamWorker(transcript_path=tee)
    patch_build_spawn(
        monkeypatch, OpenCodeCLIStreamWorker, fake_stream_argv([_step_start(), _text()])
    )
    await _drain(worker)

    types = [json.loads(line)["type"] for line in tee.read_text(encoding="utf-8").splitlines()]
    assert types[-1] == "flowpad.result"


@pytest.mark.asyncio
async def test_tool_calls_reason_is_not_treated_as_terminal(monkeypatch, tmp_path):
    tee = tmp_path / "tee.jsonl"
    worker = OpenCodeCLIStreamWorker(transcript_path=tee)
    patch_build_spawn(
        monkeypatch,
        OpenCodeCLIStreamWorker,
        fake_stream_argv([_step_start(), _step_finish("tool-calls")]),
    )
    await _drain(worker)
    # No real terminal was seen, so the worker closed the turn itself.
    types = [json.loads(line)["type"] for line in tee.read_text(encoding="utf-8").splitlines()]
    assert types[-1] == "flowpad.result"


@pytest.mark.asyncio
async def test_nonzero_exit_writes_an_error_terminal(monkeypatch, tmp_path):
    tee = tmp_path / "tee.jsonl"
    worker = OpenCodeCLIStreamWorker(transcript_path=tee)
    patch_build_spawn(
        monkeypatch, OpenCodeCLIStreamWorker, ["bash", "-c", "echo boom >&2; exit 3"]
    )
    frames = await _drain(worker)

    types = [json.loads(line)["type"] for line in tee.read_text(encoding="utf-8").splitlines()]
    assert types[-1] == "flowpad.error"
    assert any(fd.attributes.get("element-type") == FlowElementType.ERROR for fd in frames)


@pytest.mark.asyncio
async def test_missing_binary_raises_worker_spawn_error(monkeypatch, tmp_path):
    clear_harness_capability(monkeypatch, "opencode")
    worker = OpenCodeCLIStreamWorker(transcript_path=tmp_path / "tee.jsonl")
    with pytest.raises(WorkerSpawnError):
        await _drain(worker)


@pytest.mark.asyncio
async def test_build_spawn_pins_argv0_to_the_discovered_binary(monkeypatch, tmp_path):
    """The backend's PATH has no nvm on it, so argv[0] must be the absolute
    path capability discovery recorded."""
    bin_dir, exe = make_fake_cli_bin(tmp_path, "opencode")
    seed_harness_capability(monkeypatch, "opencode", bin_dir)

    worker = OpenCodeCLIStreamWorker(transcript_path=tmp_path / "tee.jsonl")
    argv, env, _stdin = worker._build_spawn(
        AgenticContext(workdir=str(tmp_path), env_vars={}), "hi"
    )
    assert argv[0] == str(exe)
    assert str(bin_dir) in env["PATH"]


@pytest.mark.asyncio
async def test_cancel_marks_graceful_and_records_its_own_abort(monkeypatch, tmp_path):
    tee = tmp_path / "tee.jsonl"
    worker = OpenCodeCLIStreamWorker(transcript_path=tee)
    patch_build_spawn(
        monkeypatch, OpenCodeCLIStreamWorker, fake_stream_argv([_step_start(), _text()])
    )
    await _drain(worker)
    assert worker.cancelled_gracefully is False

    worker2 = OpenCodeCLIStreamWorker(transcript_path=tmp_path / "tee2.jsonl")
    await worker2.close_session()
    # The worker writes its own interrupted marker, so the cancel choke point
    # must skip the flowpad sidecar or replay shows the abort twice.
    assert worker2.cancelled_gracefully is True
