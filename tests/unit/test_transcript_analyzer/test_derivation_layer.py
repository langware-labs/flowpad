"""The derivation layer — meaning is added once, for every worker.

Before this layer, each semantic entry was built inside each parser, so a kind
existed only where somebody remembered to add it: codex produced no
``SearchEntry``, copilot no ``ExitPlanModeEntry``. Those were gaps, not
decisions, and they were invisible — a missing chip looks exactly like a worker
that did not do the thing.

These tests pin the two properties that make the layer worth having: one rule
covers every worker, and derivation is additive without compounding.
"""

from __future__ import annotations

import pytest

from flow_sdk.transcript_analyzer.derivation import MAX_DERIVATION_DEPTH, derive_entries
from flow_sdk.transcript_analyzer.entries import (
    AgentSpawnEntry,
    ArtifactEntry,
    FlowCommandEntry,
    SearchEntry,
    SkillCallEntry,
    TodoUpdateEntry,
    ToolUseEntry,
    WebFetchEntry,
)
from flow_sdk.transcript_analyzer.entry import EntryKind, TranscriptEntry

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

_BASE = {"id": "e1", "session_id": "s1", "timestamp": "2026-08-02T10:00:00Z"}

WORKERS = pytest.mark.parametrize("worker", ["claude", "codex", "copilot"])


def _tool(worker: str, tool_name: str, tool_input: dict | None = None) -> ToolUseEntry:
    """A generic tool-use, i.e. what a parser emits before meaning is added."""
    return ToolUseEntry(
        tool_name=tool_name,
        tool_use_id="tu-1",
        tool_input=tool_input or {},
        **{**_BASE, "worker": worker},
    )


# ── one rule, every worker ───────────────────────────────────────────────────


@WORKERS
@pytest.mark.parametrize(
    ("tool_name", "tool_input", "expected"),
    [
        ("Grep", {"pattern": "needle"}, SearchEntry),
        ("WebFetch", {"url": "https://example.test"}, WebFetchEntry),
        ("TodoWrite", {"todos": [{"content": "x"}]}, TodoUpdateEntry),
        ("Task", {"subagent_type": "Explore"}, AgentSpawnEntry),
        ("Skill", {"skill": "decker"}, SkillCallEntry),
    ],
    ids=["search", "web_fetch", "todo_update", "agent_spawn", "skill_call"],
)
def test_a_semantic_kind_is_derived_for_every_worker(worker, tool_name, tool_input, expected):
    """The asymmetry fix. Four of these five existed only for claude."""
    out = derive_entries([_tool(worker, tool_name, tool_input)])

    derived = [e for e in out if e.virtual]
    assert len(derived) == 1, f"{worker}/{tool_name} derived {len(derived)} entries"
    assert isinstance(derived[0], expected)


@WORKERS
def test_field_aliases_are_read_across_vendor_spellings(worker):
    """Vendors spell the same argument differently; the map reads through it."""
    out = derive_entries([_tool(worker, "Grep", {"query": "needle", "filePath": "/tmp/x"})])

    search = next(e for e in out if isinstance(e, SearchEntry))
    assert search.query == "needle"
    assert search.path == "/tmp/x"


@WORKERS
def test_an_unrecognised_tool_stays_generic(worker):
    """MCP and bespoke tools must not be forced into a shape they do not have."""
    out = derive_entries([_tool(worker, "mcp__thing__do", {"x": 1})])

    assert [type(e) for e in out] == [ToolUseEntry]


# ── additive, provenanced, non-compounding ───────────────────────────────────


@WORKERS
def test_the_physical_entry_survives_derivation(worker):
    """The auditable record of what the worker actually emitted stays."""
    physical = _tool(worker, "Grep", {"pattern": "x"})
    out = derive_entries([physical])

    assert out[0] is physical
    assert out[0].virtual is False
    assert out[1].virtual is True
    assert out[1].derived_from == physical.id
    # A refinement inherits the pairing key, so the vendor's tool result still
    # attaches; only the ENTRY id is suffixed, so each layer stays addressable.
    assert out[1].tool_use_id == physical.tool_use_id
    assert out[1].id == f"{physical.id}:search"


@WORKERS
def test_derivation_is_idempotent_over_an_already_derived_list(worker):
    """``parse_delta`` re-derives the whole retained list on every delta."""
    once = derive_entries([_tool(worker, "Grep", {"pattern": "x"})])
    twice = derive_entries(once)

    assert [e.id for e in twice] == [e.id for e in once]


@WORKERS
def test_a_partially_derived_list_grows_only_the_missing_leaf(worker):
    """Re-deriving must be a repair, not a duplication: a chain missing its leaf
    gains the leaf and nothing else."""
    full = derive_entries([_tool(worker, "bash", {"command": "flow artifact file /tmp/r.html"})])
    # Chain DEPTH is worker-dependent — a worker whose parser already emits the
    # shell layer has one link fewer — so assert the leaf, not the shape.
    assert isinstance(full[-1], ArtifactEntry)
    assert any(type(e) is FlowCommandEntry for e in full)

    without_leaf = [e for e in full if not isinstance(e, ArtifactEntry)]
    repaired = derive_entries(without_leaf)

    assert [type(e) for e in repaired] == [type(e) for e in full]
    assert [e.id for e in repaired] == [e.id for e in full]


# ── termination ──────────────────────────────────────────────────────────────


def test_a_self_feeding_handler_is_capped_not_hung(caplog):
    """A handler that refines its own output must cost a log line, not a hang.

    This is not hypothetical: ``ExitPlanModeEntry`` has no ``EntryKind`` of its
    own and inherits ``TOOL_USE``, so the tool-semantics handler re-derived it
    until this cap stopped it. The cap is what turned an unbounded list into a
    diagnosable warning.
    """
    from flow_sdk.transcript_analyzer.derivation import registry

    def _always(entry: TranscriptEntry):
        from flow_sdk.transcript_analyzer.derivation.virtual import virtual_envelope

        return [ToolUseEntry(tool_name="loop", tool_use_id="", tool_input={}, **virtual_envelope(entry, "loop"))]

    registry.register("loopworker", EntryKind.TOOL_USE, _always)
    try:
        out = derive_entries([_tool("loopworker", "anything")])
    finally:
        registry._HANDLERS.pop(("loopworker", EntryKind.TOOL_USE), None)

    assert len(out) <= MAX_DERIVATION_DEPTH + 1
    assert "depth cap" in caplog.text
