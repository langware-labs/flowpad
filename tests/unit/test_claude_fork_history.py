"""A Claude fork shows its parent's history before its own transcript exists."""

from types import SimpleNamespace
from unittest.mock import patch

from flow_sdk.builtin.agentic_process.cli_drivers.claude import driver as claude_driver
from flow_sdk.builtin.agentic_process.cli_drivers.claude.driver import ClaudeDriver


def _load(process, *, has_own_transcript: bool) -> str:
    """Return which session id ``load_history`` read."""
    read: list[str] = []
    with (
        patch.object(ClaudeDriver, "transcript_path", return_value="/x.jsonl" if has_own_transcript else None),
        patch.object(claude_driver, "_claude_load_session_history", side_effect=lambda sid: read.append(sid) or []),
    ):
        ClaudeDriver().load_history(process)
    return read[0]


def test_unmaterialised_fork_reads_parent_history():
    process = SimpleNamespace(session_id="child", cli_config={"fork_session_id": "parent"})
    assert _load(process, has_own_transcript=False) == "parent"


def test_materialised_fork_reads_its_own_history():
    process = SimpleNamespace(session_id="child", cli_config={"fork_session_id": "parent"})
    assert _load(process, has_own_transcript=True) == "child"


def test_plain_session_reads_its_own_history():
    process = SimpleNamespace(session_id="child", cli_config={})
    assert _load(process, has_own_transcript=False) == "child"
