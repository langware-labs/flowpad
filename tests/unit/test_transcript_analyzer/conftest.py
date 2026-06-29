"""Shared fixtures for transcript_analyzer tests."""

from pathlib import Path

import pytest

_RESOURCES = Path(__file__).resolve().parent.parent / "resources" / "transcripts"


@pytest.fixture()
def claude_jsonl() -> Path:
    return _RESOURCES / "claude_with_exit_plan_mode.jsonl"


@pytest.fixture()
def claude_multi_block_jsonl() -> Path:
    return _RESOURCES / "claude_multi_block_message.jsonl"


@pytest.fixture()
def codex_stream_jsonl() -> Path:
    return _RESOURCES / "codex_stream_events.jsonl"


@pytest.fixture()
def codex_rollout_jsonl() -> Path:
    return _RESOURCES / "codex_rollout.jsonl"


@pytest.fixture()
def copilot_stream_jsonl() -> Path:
    return _RESOURCES / "copilot_stream_stdin_prompt.jsonl"


@pytest.fixture()
def copilot_tool_failure_jsonl() -> Path:
    return _RESOURCES / "copilot_stream_tool_failure.jsonl"


@pytest.fixture()
def copilot_bad_model_jsonl() -> Path:
    return _RESOURCES / "copilot_stream_bad_model.jsonl"


# ── workflow run fixtures (the 3-agent probe run wf_a8e936fe-3a9) ──────────────
_WF_RUN_ID = "wf_a8e936fe-3a9"
_WF_ROOT = _RESOURCES / "workflows"


@pytest.fixture()
def workflow_journal() -> Path:
    """The single-JSON workflow run journal (wf_<runId>.json)."""
    return _WF_ROOT / "workflows" / f"{_WF_RUN_ID}.json"


@pytest.fixture()
def workflow_run_id() -> str:
    return _WF_RUN_ID


@pytest.fixture()
def workflow_child_jsonls() -> list[Path]:
    """The spawned sub-agents' Claude-format transcripts."""
    child_dir = _WF_ROOT / "subagents" / "workflows" / _WF_RUN_ID
    return sorted(child_dir.glob("agent-*.jsonl"))
