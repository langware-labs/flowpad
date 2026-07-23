"""``flow`` CLI derivation — one rule, every worker.

``FlowCommandEntry`` is DERIVED from an already-parsed shell command, not
parsed off a raw line. Each worker hands the derivation a different entry
shape, so every case here runs against all three:

* claude  — ``ShellCommandEntry`` (the ``Bash`` tool maps to it in the parser)
* codex   — ``ToolUseEntry(tool_name="shell")`` with an argv list
* copilot — ``ToolUseEntry(tool_name="bash")`` with a command string
"""

from __future__ import annotations

import pytest

from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType
from flow_sdk.transcript_analyzer.derive import (
    derive_entries,
    derive_entry,
    parse_flow_invocation,
)
from flow_sdk.transcript_analyzer.entries import (
    FlowCommandEntry,
    ShellCommandEntry,
    ToolUseEntry,
)
from flow_sdk.transcript_analyzer.entry import EntryKind

_BASE = {
    "id": "e1",
    "session_id": "s1",
    "timestamp": "2026-07-23T10:00:00Z",
    "worker": "test",
}

_TYPE_ID = "skill-3f2a1b4c-0000-4000-8000-000000000001"


def _claude(command: str) -> ShellCommandEntry:
    return ShellCommandEntry(
        command=command, tool_name="Bash", tool_use_id="tu-1", **{**_BASE, "worker": "claude"}
    )


def _codex(command: str) -> ToolUseEntry:
    return ToolUseEntry(
        tool_name="shell",
        tool_use_id="tu-1",
        tool_input={"command": ["bash", "-lc", command]},
        **{**_BASE, "worker": "codex"},
    )


def _copilot(command: str) -> ToolUseEntry:
    return ToolUseEntry(
        tool_name="bash",
        tool_use_id="tu-1",
        tool_input={"command": command},
        **{**_BASE, "worker": "copilot"},
    )


WORKERS = pytest.mark.parametrize("make", [_claude, _codex, _copilot], ids=["claude", "codex", "copilot"])


# ── positives ─────────────────────────────────────────────────────────────────


@WORKERS
def test_show_entity_carries_verb_subverb_target(make):
    derived = derive_entry(make(f"flow show entity {_TYPE_ID}"))

    assert isinstance(derived, FlowCommandEntry)
    assert derived.kind is EntryKind.FLOW_COMMAND
    assert (derived.verb, derived.subverb, derived.target) == ("show", "entity", _TYPE_ID)


@WORKERS
def test_show_file_targets_the_path(make):
    derived = derive_entry(make("flow show file '~/Flowpad workspace/proj/index.html'"))

    assert isinstance(derived, FlowCommandEntry)
    assert derived.subverb == "file"
    assert derived.target == "~/Flowpad workspace/proj/index.html"


@WORKERS
def test_env_prefix_is_stripped(make):
    derived = derive_entry(make("FLOW_INSTANCE=oss flow record --type task --title x"))

    assert isinstance(derived, FlowCommandEntry)
    assert derived.verb == "record"
    assert derived.subverb is None and derived.target is None


@WORKERS
def test_option_before_verb_still_resolves(make):
    derived = derive_entry(make("flow --json navigate entity " + _TYPE_ID))

    assert isinstance(derived, FlowCommandEntry)
    assert (derived.verb, derived.subverb, derived.target) == ("navigate", "entity", _TYPE_ID)


@WORKERS
def test_shell_fields_survive_the_refinement(make):
    entry = make("flow context get")
    # Whatever the worker recorded on the call (Claude folds exit_code/stdout
    # in from the paired result) must ride along onto the derived entry.
    entry.exit_code = 0
    entry.stdout_preview = "ok"
    derived = derive_entry(entry)

    assert isinstance(derived, FlowCommandEntry)
    assert derived.command.endswith("flow context get")
    assert derived.exit_code == 0
    assert derived.stdout_preview == "ok"
    assert derived.tool_use_id == "tu-1"
    assert derived.id == entry.id and derived.timestamp == entry.timestamp


# ── negatives ─────────────────────────────────────────────────────────────────


@WORKERS
@pytest.mark.parametrize(
    "command",
    [
        "flowctl show entity x",       # different binary
        "./flow show entity x",        # not the bare `flow` token
        "echo flow show entity x",     # merely mentions it
        "flow bogusverb x",            # unregistered verb
        "npm run flow",                # substring in an unrelated command
        "",                            # nothing at all
    ],
)
def test_non_flow_commands_are_left_alone(make, command):
    entry = make(command)
    assert derive_entry(entry) is entry


def test_non_shell_tool_use_is_left_alone():
    entry = ToolUseEntry(
        tool_name="mcp__thing__do",
        tool_use_id="tu-9",
        tool_input={"command": "flow show entity x"},
        **_BASE,
    )
    assert derive_entry(entry) is entry


# ── purity ────────────────────────────────────────────────────────────────────


@WORKERS
def test_derivation_is_idempotent(make):
    once = derive_entry(make(f"flow show entity {_TYPE_ID}"))
    twice = derive_entry(once)

    assert twice is once  # refold re-derives the full list on every delta


@WORKERS
def test_derive_entries_maps_and_preserves_order(make):
    entries = [make("ls -la"), make(f"flow show entity {_TYPE_ID}"), make("pwd")]
    out = derive_entries(entries)

    assert [type(e) for e in out] == [type(entries[0]), FlowCommandEntry, type(entries[2])]


# ── flow_data shape ───────────────────────────────────────────────────────────


@WORKERS
def test_to_flow_data_carries_flow_attributes_and_still_pairs(make):
    derived = derive_entry(make(f"flow show entity {_TYPE_ID}"))
    [fd] = derived.to_flow_data()

    assert fd.attributes["element-type"] == FlowElementType.TOOL_CALL
    assert fd.attributes["flow-verb"] == "show"
    assert fd.attributes["flow-subverb"] == "entity"
    assert fd.attributes["flow-target"] == _TYPE_ID
    # Pairing with the TOOL_RESULT is by tool_call_id — must not regress.
    assert fd.flow_value["tool_call_id"] == "tu-1"
    assert fd.flow_value["flow_target"] == _TYPE_ID


# ── the parser primitive ──────────────────────────────────────────────────────


def test_parse_flow_invocation_returns_none_on_unbalanced_quotes():
    assert parse_flow_invocation("flow show file 'unterminated") is None
