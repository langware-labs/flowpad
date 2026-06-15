"""Regression guard — a list query must not full-parse every process's transcript.

Proven root cause (2026-06-15, faulthandler on :9007): the event loop was pinned
~100% CPU (NOT on the SQLite writer lock — measured max lock-hold 366ms) on:

    GET /query -> DBEntity.get_all -> _get_all_entity_attrs -> pydantic model_dump
      -> AgenticProcess.api_json_serializer  (did data["cmd_line"] = self.cmd_line)
        -> cli_options -> transcript_descriptor -> get_claude_session
          -> extract_claude_session_from_path(...)   # include_content=True (default at the time)
            -> worker_summary_log -> Transcript._read_and_fold   # FULL transcript parse

So serializing ONE process fully parsed its transcript; a list query did N parses
back-to-back on the single uvloop thread (~0.25s each), starving the concurrent
createProcess (13–31s hang).

The fix is applied: ``get_claude_session`` resolves paths with
``include_content=False`` (no ``worker_summary_log``). This test therefore PASSES
now — it is the regression guard for that fix: it drives the REAL resolver
(``get_claude_session``, exactly what ``api_json_serializer`` reached) once per
process a list query would serialize, and asserts the total stays under the 4s
interactive budget. If ``include_content`` ever reverts to ``True``, each lookup
re-parses and the budget is blown, failing here with the bug's signature.

The transcript MUST stay large and ``N_PROCESSES`` realistic: that is what gives
the guard teeth — a reverted bug only exceeds 4s when re-parsing a heavy
transcript many times. ``N_PROCESSES`` is the controlled workload, not a widened
wait/timeout; the 30s cap stands.
"""
from __future__ import annotations

import time

import pytest

from flow_sdk.fs_store.indexer.functions.claude_sessions import get_claude_session

from .conftest import CLAUDE_SID, write_claude_transcript

BUDGET_MS = 4000          # interactive budget for the list query / createProcess
N_PROCESSES = 45          # processes a single list query serializes (busy instance has dozens)
_TRANSCRIPT_LINES = 20000  # a realistically-large session


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_list_query_transcript_parse_under_4s(claude_projects):
    write_claude_transcript(claude_projects, n_lines=_TRANSCRIPT_LINES)

    # Simulate a list query (get_all) serializing N processes: each model_dump's
    # api_json_serializer resolves the transcript path via get_claude_session.
    # With include_content=False this is a cheap path lookup; were it True it
    # would run the full worker_summary_log parse per process.
    t0 = time.perf_counter()
    for _ in range(N_PROCESSES):
        rec = get_claude_session(CLAUDE_SID)
        assert rec is not None and rec.jsonl_path  # path resolved (all the caller needs)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    print(f"[list-parse guard] {N_PROCESSES} processes resolved in {elapsed_ms:.0f}ms "
          f"(budget {BUDGET_MS}ms) — {elapsed_ms/N_PROCESSES:.0f}ms/lookup")

    assert elapsed_ms < BUDGET_MS, (
        f"resolving {N_PROCESSES} processes took {elapsed_ms:.0f}ms (> {BUDGET_MS}ms) — "
        f"get_claude_session is full-parsing transcripts again; it must resolve paths "
        f"with include_content=False"
    )
