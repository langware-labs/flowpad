"""``flow`` CLI derivation — one rule, every worker.

``FlowCommandEntry`` is DERIVED from an already-parsed shell command, not
parsed off a raw line. Each worker hands the derivation a different entry
shape, so every case here runs against all three:

* claude  — ``ShellCommandEntry`` (the ``Bash`` tool maps to it in the parser)
* codex   — ``ToolUseEntry(tool_name="shell")`` with an argv list
* copilot — ``ToolUseEntry(tool_name="bash")`` with a command string
"""

from __future__ import annotations

import shlex

import pytest

from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType
from flow_sdk.transcript_analyzer.derive import (
    derive_entries,
    derive_entry,
    parse_flow_invocation,
)
from flow_sdk.transcript_analyzer.entries import (
    ArtifactEntry,
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

# Parsers synthesize a distinct id per transcript line. Derived ids are
# `{source.id}:{layer}`, so reusing one id across entries would make the second
# entry's refinement collide with the first's and be dropped as a re-derive.
_ids = iter(f"e{n}" for n in range(1, 10_000))


def _base(worker: str) -> dict:
    return {**_BASE, "id": next(_ids), "worker": worker}


_TYPE_ID = "skill-3f2a1b4c-0000-4000-8000-000000000001"


def _claude(command: str) -> ShellCommandEntry:
    return ShellCommandEntry(command=command, tool_name="Bash", tool_use_id="tu-1", **_base("claude"))


def _codex(command: str) -> ToolUseEntry:
    return ToolUseEntry(
        tool_name="shell",
        tool_use_id="tu-1",
        tool_input={"command": ["bash", "-lc", command]},
        **_base("codex"),
    )


def _copilot(command: str) -> ToolUseEntry:
    return ToolUseEntry(
        tool_name="bash",
        tool_use_id="tu-1",
        tool_input={"command": command},
        **_base("copilot"),
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
def test_connect_derives_for_every_worker(make):
    derived = derive_entry(make("flow connect"))

    assert isinstance(derived, FlowCommandEntry)
    assert derived.verb == "connect"
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
    # tool_use_id is INHERITED, not suffixed: it is the pairing key the vendor's
    # tool result carries, and a refinement that changed it would render as a
    # call that never finished.
    assert derived.tool_use_id == "tu-1"
    # The ENTRY id is suffixed per layer — every layer needs a unique id, and
    # the registry's visited set relies on it to fire a handler once. The id is
    # rooted in the source's, so depth is visible but not asserted: claude's
    # parser supplies the shell layer, codex's and copilot's does not, so their
    # chains are one link longer for a legitimate reason.
    assert derived.id.startswith(entry.id) and derived.id.endswith(":flow_command")
    assert derived.derived_from is not None
    assert derived.virtual is True
    assert derived.timestamp == entry.timestamp


# ── `flow artifact` — durable output registration ────────────────────────
#
# `flow artifact` records durable provenance and may also present its target.
# `flow show` remains the display-only verb. Derivation must be harness-symmetric:
# one command string, one identical `FlowCommandEntry` on all three workers.
# Everything downstream (chip, capture, replay) reads that entry.


@WORKERS
def test_artifact_entity_carries_verb_subverb_target(make):
    derived = derive_entry(make(f"flow artifact entity {_TYPE_ID}"))

    # `derive_entry` returns the DEEPEST refinement — the chip a consumer should
    # render. `flow artifact` refines one layer further than a plain flow call:
    # shell → flow_command → artifact.
    assert isinstance(derived, ArtifactEntry)
    assert derived.kind is EntryKind.ARTIFACT
    assert (derived.verb, derived.subverb, derived.target) == ("artifact", "entity", _TYPE_ID)


@WORKERS
def test_artifact_file_targets_the_path(make):
    derived = derive_entry(make("flow artifact file '~/Flowpad workspace/proj/report.html'"))

    assert isinstance(derived, FlowCommandEntry)
    assert derived.subverb == "file"
    assert derived.target == "~/Flowpad workspace/proj/report.html"


@WORKERS
def test_artifact_webapp_targets_the_port(make):
    # `webapp` is already in `_TARGETED`, and the port value is the first
    # positional after it — so the chip gets a target without a special case.
    derived = derive_entry(make("flow artifact webapp --port 3300"))

    assert isinstance(derived, FlowCommandEntry)
    assert (derived.verb, derived.subverb, derived.target) == ("artifact", "webapp", "3300")


@WORKERS
def test_artifact_derivation_is_idempotent(make):
    once = derive_entry(make(f"flow artifact entity {_TYPE_ID}"))
    twice = derive_entry(once)

    assert twice is once


@WORKERS
def test_artifact_to_flow_data_carries_flow_attributes(make):
    derived = derive_entry(make(f"flow artifact entity {_TYPE_ID}"))
    [fd] = derived.to_flow_data()

    assert fd.attributes["element-type"] == FlowElementType.TOOL_CALL
    assert fd.attributes["flow-verb"] == "artifact"
    assert fd.attributes["flow-subverb"] == "entity"
    assert fd.attributes["flow-target"] == _TYPE_ID
    assert fd.flow_value["tool_call_id"] == "tu-1"
    assert fd.flow_value["flow_target"] == _TYPE_ID


@WORKERS
@pytest.mark.parametrize(
    "wrapper",
    [
        "/bin/zsh -lc {q}",
        "/bin/bash -lc {q}",
        "bash -c {q}",
        "/bin/sh -c {q}",
    ],
)
def test_login_shell_wrapper_is_unwrapped(make, wrapper):
    """Real codex sends ``/bin/zsh -lc 'flow artifact …'`` as ONE string.

    Captured from a live codex turn. The vendor's argv-LIST form
    (``["bash","-lc",cmd]``) hid this for years because that branch already
    reads the last element — but the string form made ``tokens[0]`` the shell
    binary, so no `flow` call on codex ever derived and every chip silently
    degraded to a generic shell row.
    """
    inner = f"flow artifact entity {_TYPE_ID}"
    derived = derive_entry(make(wrapper.format(q=shlex.quote(inner))))

    assert isinstance(derived, FlowCommandEntry), f"{wrapper!r} left the call underived"
    assert (derived.verb, derived.subverb, derived.target) == ("artifact", "entity", _TYPE_ID)


@WORKERS
def test_a_non_shell_leading_binary_derives_no_flow_command(make):
    """The unwrap must not turn any quoted argument into a flow call."""
    out = derive_entries([make("docker run -c 'flow artifact entity x'")])

    assert not [e for e in out if isinstance(e, FlowCommandEntry)]


def test_artifact_and_show_verbs_coexist_in_the_registry():
    """Durable artifact registration and display-only show are distinct contracts."""
    from flow_sdk.transcript_analyzer.derive import _FLOW_VERBS

    assert {"artifact", "show"} <= _FLOW_VERBS


# ── negatives ─────────────────────────────────────────────────────────────────


@WORKERS
@pytest.mark.parametrize(
    "command",
    [
        "flowctl show entity x",  # different binary
        "./flow show entity x",  # not the bare `flow` token
        "echo flow show entity x",  # merely mentions it
        "flow bogusverb x",  # unregistered verb
        "npm run flow",  # substring in an unrelated command
        "",  # nothing at all
    ],
)
def test_non_flow_commands_derive_no_flow_command(make, command):
    """A shell command that is not a `flow` call yields no flow entry.

    It may still yield a ShellCommandEntry — on codex and copilot the parser
    hands us a generic tool-use, and turning that into a shell entry is the
    layer closing a gap, not a false positive. What must never appear is a
    FLOW command.
    """
    out = derive_entries([make(command)])
    assert not [e for e in out if isinstance(e, FlowCommandEntry)]


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
def test_derive_entries_appends_beside_the_source(make):
    """Derivation is ADDITIVE: the physical entry stays, the meaning is appended.

    The physical record of what the worker actually emitted has to survive —
    it is the auditable trace, and a consumer that wants only meaning filters on
    ``virtual``. A refinement lands immediately after its source so a chain
    reads in layer order.
    """
    entries = [make("ls -la"), make(f"flow show entity {_TYPE_ID}"), make("pwd")]
    out = derive_entries(entries)

    # Every physical entry survives, in order, and is still flagged physical.
    assert [e for e in out if not e.virtual] == entries

    # Exactly one flow command is derived — from the middle entry, not the
    # neighbours. Chain DEPTH is worker-dependent (claude's parser already
    # produces the ShellCommandEntry layer, codex and copilot hand us a generic
    # tool-use that the layer refines first), so this asserts provenance rather
    # than a list shape that would differ per worker for the wrong reason.
    flow = [e for e in out if type(e) is FlowCommandEntry]
    assert len(flow) == 1
    assert _roots_at(flow[0], out) is entries[1]


def _roots_at(entry, out):
    """Walk ``derived_from`` back to the physical entry a refinement came from."""
    by_id = {e.id: e for e in out}
    while entry.derived_from is not None and entry.derived_from in by_id:
        entry = by_id[entry.derived_from]
    return entry


@WORKERS
def test_an_artifact_call_derives_a_chain_ending_in_the_artifact(make):
    """Each layer is one rule; the leaf is what a consumer renders.

    Depth differs by worker and that is correct: claude's parser already emits
    the ShellCommandEntry layer, so its chain is one shorter than codex's and
    copilot's, whose generic tool-use the layer refines first.
    """
    physical = make("flow artifact file /tmp/report.html")
    out = derive_entries([physical])

    assert out[0] is physical and physical.virtual is False
    assert all(e.virtual for e in out[1:])
    # The leaf is the artifact, and the chain is connected all the way back —
    # which is what lets a consumer suppress everything but the leaf.
    assert isinstance(out[-1], ArtifactEntry)
    assert _roots_at(out[-1], out) is physical
    assert any(type(e) is FlowCommandEntry for e in out)


@WORKERS
def test_repeated_derivation_does_not_compound(make):
    """`parse_delta` re-derives the whole retained list on every delta, so
    deriving an already-derived list must add nothing."""
    once = derive_entries([make(f"flow artifact entity {_TYPE_ID}")])
    twice = derive_entries(once)

    assert len(twice) == len(once)
    assert [type(e) for e in twice] == [type(e) for e in once]


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


# ── drift guard ───────────────────────────────────────────────────────────────


def test_flow_verbs_match_the_real_cli_registry():
    """``_FLOW_VERBS`` must stay in sync with the commands ``flow`` actually has.

    The set is a static copy so the transcript analyzer never imports the CLI
    (typer + its dependency tree) on a per-entry parse path. That copy is only
    safe if drift is caught here: adding a verb to ``flow_cli.py`` without
    listing it makes its chip silently degrade to a generic shell row, while a
    retired verb left behind makes an invalid call look real.
    """
    from flow_sdk.cli.flow_cli import app
    from flow_sdk.transcript_analyzer.derive import _FLOW_VERBS

    registered = {cmd.name or cmd.callback.__name__.replace("_", "-") for cmd in app.registered_commands} | {
        group.name for group in app.registered_groups
    }

    assert registered == _FLOW_VERBS, (
        f"`flow` verb registry drift: missing={sorted(registered - _FLOW_VERBS)}, "
        f"retired={sorted(_FLOW_VERBS - registered)}"
    )
