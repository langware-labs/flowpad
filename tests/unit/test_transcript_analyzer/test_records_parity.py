"""Parity guard: analyzer entry ids agree with the existing FS-store Record parser.

While ``fs_records/claude/transcript_records/*`` keeps its independent parser
(deferred Records migration — see plan), this test asserts the two paths
agree on entry identity. Drift here = silent indexer/FTS divergence after
the Records migration lands.
"""

from __future__ import annotations

import json
import warnings

from flow_sdk.fs_records.claude.transcript_records import create_transcript_entry
from flow_sdk.transcript_analyzer import AgentTranscript, UnknownEntry


def test_id_set_matches_record_path_for_known_lines(claude_jsonl):
    # Analyzer side.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        t = AgentTranscript("claude", claude_jsonl)
    analyzer_ids = {e.id for e in t.entries if not isinstance(e, UnknownEntry)}

    # Record side — same fixture, line by line, skip the synthetic unknown
    # last line (Records would also fall back on it but we don't compare ids
    # for unknowns since each path may synthesize them differently).
    record_ids: set[str] = set()
    with claude_jsonl.open() as f, warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for line in f:
            line = line.strip()
            if not line:
                continue
            raw = json.loads(line)
            if raw.get("type") == "totally-novel-type-future-claude":
                continue
            rec = create_transcript_entry(raw)
            # Record's ``id`` falls back to an auto-generated UUID when the
            # type has no uid_mapping match (permission-mode, last-prompt,
            # …). Skip those — they're non-deterministic across parses on
            # the Record side, so parity is undefined. Compare only entries
            # where the Record's ``entry_uuid`` resolved to a real value
            # from the JSONL line.
            if raw.get("type") == "user":
                content = (raw.get("message") or {}).get("content") or []
                if any(isinstance(block, dict) and block.get("type") == "tool_result" for block in content):
                    # Tool result rows are folded into the semantic operation
                    # entry by AgentTranscript, so their own record id is not
                    # expected to appear as a separate analyzer entry.
                    continue
            if rec.entry_uuid:
                record_ids.add(rec.id)

    # Analyzer should produce a strict superset (it always synthesizes when
    # uuid is missing). Every Record id must be in the analyzer set.
    missing = record_ids - analyzer_ids
    assert not missing, f"Records have ids the analyzer does not: {missing}"
