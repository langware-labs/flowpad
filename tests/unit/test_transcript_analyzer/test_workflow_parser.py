"""WorkflowParser — parse a Claude Code workflow run journal as a transcript.

The journal is a single JSON object (not JSONL); ``AgentTranscriptFile`` reads it
whole via the ``whole_document`` path and maps it onto existing entry kinds:
``MetaEntry(session_meta)`` envelope, one ``MetaEntry(workflow_phase)`` per phase,
and one ``AgentSpawnEntry`` per spawned agent. Children are plain Claude transcripts.
"""

import pytest

from flow_sdk.transcript_analyzer.entries import AgentSpawnEntry, MetaEntry
from flow_sdk.transcript_analyzer.entry import EntryKind
from flow_sdk.transcript_analyzer.parsers import WorkflowParser, get_parser_class
from flow_sdk.transcript_analyzer.transcript import AgentTranscriptFile

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


def test_registry_resolves_workflow_worker():
    assert get_parser_class("workflow") is WorkflowParser
    assert WorkflowParser.whole_document is True


def test_journal_parses_into_meta_and_spawn_entries(workflow_journal, workflow_run_id):
    tf = AgentTranscriptFile("workflow", workflow_journal)
    entries = tf.entries
    assert entries, "expected parsed entries from the journal"

    # session_id resolves to the runId, surfaced from the journal envelope.
    assert tf.session_id == workflow_run_id

    # Leading session_meta carries the run envelope.
    meta = entries[0]
    assert isinstance(meta, MetaEntry)
    assert meta.meta_kind == "session_meta"
    assert meta.payload["runId"] == workflow_run_id
    assert meta.payload["workflowName"] == "anatomy-probe"
    assert meta.payload["status"] == "completed"
    assert meta.payload["agentCount"] == 3

    # One phase MetaEntry.
    phases = [e for e in entries if isinstance(e, MetaEntry) and e.meta_kind == "workflow_phase"]
    assert len(phases) == 1
    assert phases[0].payload["title"] == "Probe"

    # One AgentSpawnEntry per spawned agent, AGENT_SPAWN kind, linked by agentId.
    spawns = [e for e in entries if isinstance(e, AgentSpawnEntry)]
    assert len(spawns) == 3
    for s in spawns:
        assert s.kind is EntryKind.AGENT_SPAWN
        assert s.agent_type.startswith("probe-")     # the workflow label
        assert s.tool_use_id.startswith("a")          # the child agentId
        assert s.model                                # carried from the journal
        assert s.session_id == workflow_run_id


def test_spawn_ids_match_child_files(workflow_journal, workflow_child_jsonls):
    """Each AgentSpawnEntry.tool_use_id is a real child agentId on disk."""
    tf = AgentTranscriptFile("workflow", workflow_journal)
    spawn_ids = {e.tool_use_id for e in tf.entries if isinstance(e, AgentSpawnEntry)}
    child_ids = {p.stem.removeprefix("agent-") for p in workflow_child_jsonls}
    assert spawn_ids == child_ids


def test_phases_regroup_agents_under_their_phase():
    """Journal lists all phases first then all agents; the parser regroups so
    each phase divider is followed by its own agents (by phaseIndex)."""
    from pathlib import Path
    journal = (
        Path(__file__).resolve().parent.parent
        / "resources" / "transcripts" / "workflows" / "workflows" / "wf_3747c4bd-e3c.json"
    )
    tf = AgentTranscriptFile("workflow", journal)
    # Drop the leading session_meta; assert the interleaved order.
    seq = [
        (e.meta_kind, e.payload.get("title")) if isinstance(e, MetaEntry) else ("spawn", e.agent_type)
        for e in tf.entries
        if not (isinstance(e, MetaEntry) and e.meta_kind == "session_meta")
    ]
    assert seq == [
        ("workflow_phase", "Gather"),
        ("spawn", "gather-1"),
        ("spawn", "gather-2"),
        ("workflow_phase", "Summarize"),
        ("spawn", "summarizer"),
    ]


def test_child_transcript_path_stamping(workflow_journal):
    """The transcripts route stamps each spawn with its child transcript path
    (only when the child exists), so the UI can drill in."""
    from flow_sdk.server.routes.transcripts import _stamp_workflow_child_paths

    tf = AgentTranscriptFile("workflow", workflow_journal)
    _stamp_workflow_child_paths(tf, workflow_journal)
    spawns = [e for e in tf.entries if isinstance(e, AgentSpawnEntry)]
    assert spawns
    for s in spawns:
        assert s.child_transcript_path, f"{s.tool_use_id} should be stamped"
        from pathlib import Path
        assert Path(s.child_transcript_path).exists()
        assert s.child_transcript_path.endswith(f"agent-{s.tool_use_id}.jsonl")
        # The optional field round-trips through to_dict only when set.
        assert s.to_dict()["child_transcript_path"] == s.child_transcript_path


def test_to_dict_omits_child_path_when_unset():
    """A plain (non-workflow) spawn never emits child_transcript_path."""
    e = AgentSpawnEntry(
        agent_type="x", id="i", session_id="s", timestamp="", worker="claude",
    )
    assert "child_transcript_path" not in e.to_dict()


def test_children_parse_as_claude_transcripts(workflow_child_jsonls):
    """The spawned sub-agents reuse the Claude parser verbatim — no new code."""
    assert workflow_child_jsonls, "fixture should have child transcripts"
    for child in workflow_child_jsonls:
        sub = AgentTranscriptFile("claude", child)
        assert sub.entries, f"child {child.name} should parse as a claude transcript"
        assert all(e.worker == "claude" for e in sub.entries)


def test_whole_document_does_not_disturb_line_based_workers(claude_jsonl):
    """Regression guard: the whole-document branch is only taken for whole_document
    parsers; a normal JSONL claude transcript still parses line-by-line."""
    tf = AgentTranscriptFile("claude", claude_jsonl)
    assert tf.entries
    # ClaudeParser implements the Parser Protocol but doesn't set the flag, so
    # the whole-document branch (guarded by getattr(..., False)) is never taken.
    assert getattr(tf._parser, "whole_document", False) is False
