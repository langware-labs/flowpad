"""Shared fixtures for transcript_analyzer tests."""

from pathlib import Path

import pytest

_RESOURCES = Path(__file__).resolve().parent.parent / "resources" / "transcripts"


@pytest.fixture()
def claude_jsonl() -> Path:
    return _RESOURCES / "claude_with_exit_plan_mode.jsonl"


@pytest.fixture()
def codex_stream_jsonl() -> Path:
    return _RESOURCES / "codex_stream_events.jsonl"


@pytest.fixture()
def codex_rollout_jsonl() -> Path:
    return _RESOURCES / "codex_rollout.jsonl"
