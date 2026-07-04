"""Live worker validation for asset-backed system instructions.

Run:

    DEEP_TESTING=1 uv run pytest tests/long_tests/test_system_prompt.py -v -s
"""

from __future__ import annotations

import asyncio
import json
import shutil
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.transcript_analyzer import AgentTranscriptFile, EntryKind
from flow_sdk.transcript_analyzer.resolver import TranscriptNotFoundError, resolve_session_jsonl
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
    pytest.mark.asyncio,
]

_WORKERS = [
    pytest.param(WorkerType.CLAUDE_CODE, "claude", id="claude"),
    pytest.param(WorkerType.CODEX, "codex", id="codex"),
    pytest.param(WorkerType.COPILOT, "copilot", id="copilot"),
]

_ANALYZER_NAME = {
    WorkerType.CLAUDE_CODE: "claude",
    WorkerType.CODEX: "codex",
    WorkerType.COPILOT: "copilot",
}


@pytest.fixture(scope="module")
async def _workers_discovered():
    from flow_sdk.core.capabilities.discovery import ensure_discovered

    await ensure_discovered()


def _small_cli_config(worker_type: WorkerType) -> dict:
    config = {"permission_mode": "bypassPermissions"}
    if worker_type is WorkerType.CLAUDE_CODE:
        config["model"] = "sm"
    return config


@pytest.mark.parametrize("worker_type, cli_name", _WORKERS)
@pytest.mark.timeout(150)
async def test_system_prompt(worker_type, cli_name, tmp_path: Path, _workers_discovered):
    if shutil.which(cli_name) is None:
        pytest.skip(f"{cli_name} CLI not installed")

    random_name = f"sysprobe-{uuid.uuid4().hex[:10]}"
    current_time = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    system_prompt = (
        f"Your name is {random_name} and the time is {current_time}. "
        "When asked for your name and the time, answer with these exact values."
    )

    process = AgenticProcess(
        worker_type=worker_type,
        workdir=str(tmp_path),
        visible=False,
        pty_mode=False,
        load_flowpad_assistant=False,
        cli_config=_small_cli_config(worker_type),
    )
    process.instructions = system_prompt

    try:
        result = await process.prompt(
            "What is your name and what is the time? Reply with only the name and time."
        )
        assert getattr(result, "status", "SUCCESS") == "SUCCESS", result

        assets = process.embedded_assets
        assert assets is not None
        assert str(assets.os_path) in process.additional_dirs
        for rel in (
            "CLAUDE.md",
            "AGENTS.md",
            ".agents",
            ".github/instructions/flowpad.instructions.md",
        ):
            path = assets.os_path / rel
            assert path.exists(), path
            assert system_prompt in path.read_text(encoding="utf-8")

        body = await _await_assistant_text(
            process,
            worker_type,
            random_name=random_name,
            current_time=current_time,
            deadline_s=120,
        )
        infra_error_tokens = ("prompt error:", "not logged in", "authentication", "rate limit")
        if any(token in body.lower() for token in infra_error_tokens):
            pytest.skip(f"{cli_name} CLI could not complete a live turn: {body[:500]}")

        assert random_name in body
        assert current_time in body
    finally:
        await asyncio.shield(_safe_exit(process))


def _resolve_transcript(process: AgenticProcess, worker_type: WorkerType) -> AgentTranscriptFile | None:
    tf = process._load_transcript()
    if tf is not None:
        return tf
    session_id = process.session_id
    if not session_id:
        return None
    worker_key = _ANALYZER_NAME[worker_type]
    try:
        path = resolve_session_jsonl(worker_key, session_id)
    except (TranscriptNotFoundError, ValueError):
        return None
    if path and path.exists():
        return AgentTranscriptFile(worker_key, path)
    return None


def _assistant_text(transcript: AgentTranscriptFile) -> str:
    return "\n".join(
        getattr(entry, "text", "")
        for entry in transcript.filter(kind=EntryKind.ASSISTANT_MESSAGE)
        if getattr(entry, "text", "")
    )


def _transcript_dump(transcript: AgentTranscriptFile | None) -> str:
    if transcript is None:
        return ""
    return "\n".join(
        json.dumps(entry.to_dict(), sort_keys=True, default=str)
        for entry in transcript.entries
    )


async def _await_assistant_text(
    process: AgenticProcess,
    worker_type: WorkerType,
    *,
    random_name: str,
    current_time: str,
    deadline_s: float,
) -> str:
    deadline = time.monotonic() + deadline_s
    last_text = ""
    last_transcript: AgentTranscriptFile | None = None
    while time.monotonic() < deadline:
        transcript = _resolve_transcript(process, worker_type)
        if transcript is not None:
            last_transcript = transcript
            last_text = _assistant_text(transcript)
            if random_name in last_text and current_time in last_text:
                return last_text
        await asyncio.sleep(2.0)
    return last_text or _transcript_dump(last_transcript)


async def _safe_exit(process: AgenticProcess) -> None:
    try:
        await process.exit()
    except Exception:
        pass
