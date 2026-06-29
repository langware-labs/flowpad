"""Guard: serializing an AgenticProcess must never full-parse a transcript.

Invariant (RCA 2026-06-15): ``model_dump()`` is the universal currency —
persistence, query-filter (``_entity_matches_filter`` calls it per row), WS
broadcast, and the REST list response all serialize entities. So it must stay a
cheap projection of stored state and must NOT trigger ``worker_summary_log``
(the full O(transcript-size) JSONL parse). The regression that motivated this:
``api_json_serializer`` eagerly set ``cmd_line`` → ``cli_options`` →
``transcript_descriptor`` → ``get_claude_session`` →
``extract_claude_session_from_path(include_content=True)`` →
``worker_summary_log``, so a list query re-parsed every process's transcript on
the event-loop thread (13–31s createProcess hang).

This guard spies ``worker_summary_log`` and asserts a real ``model_dump()`` never
calls it — it would fail if cmd_line returned to the dump or get_claude_session
reverted to parsing content.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

import flow_sdk.transcript_analyzer as _transcript_analyzer
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

from .conftest import CLAUDE_SID, write_claude_transcript


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_model_dump_does_not_full_parse_transcript(claude_projects):
    # a resolvable transcript the old cmd_line path would have parsed
    write_claude_transcript(claude_projects)
    proc = AgenticProcess(worker_type="claude_code", session_id=CLAUDE_SID, workdir="/repo")

    # The local import inside extract_claude_session_from_path resolves this
    # attribute at call time, so patching the package attribute spies the parse.
    with patch.object(_transcript_analyzer, "worker_summary_log", return_value="") as spy:
        proc.model_dump()  # the universal serialization path (runs api_json_serializer)

    assert spy.call_count == 0, (
        "model_dump() triggered a full transcript parse (worker_summary_log) — "
        "serialization must stay I/O-light; resolve cmd_line via the explicit action."
    )
