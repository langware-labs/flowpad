"""The shared live-frame envelope, and the two divergences it deliberately keeps.

`wrap_live` is shared by codex, copilot and opencode. Two things are NOT shared,
and both are pinned here by negative-space tests so a future "let's finish the
job" commit fails loudly rather than silently changing what the UI renders:

1. **Claude's `_wrap_live` is different on purpose** — no `derive_entry`, always
   a fresh `FlowData`, two attributes instead of four.
2. **The kind→element mapping is a parameter, not a shared table** — claude and
   codex map ~10 kinds to TOOL_CALL; copilot and opencode map only `tool_use`,
   so the same `file_write` is a STATUS chip on one pair and a TOOL_CALL chip on
   the other.
"""

from __future__ import annotations

import inspect

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.replay_envelope import wrap_live
from flow_sdk.transcript_analyzer.entries import AssistantMessageEntry, UsageEntry

_VENDOR_MODULES = ["codex", "copilot", "opencode"]


def _converter(vendor: str):
    module = __import__(
        f"flow_sdk.builtin.agentic_process.cli_drivers.{vendor}.event_to_flowdata",
        fromlist=["_wrap_live"],
    )
    return module._wrap_live


def _assistant_entry():
    return AssistantMessageEntry(
        id="e1", session_id="s1", timestamp="2026-01-01T00:00:00+00:00",
        worker="test", parent_id=None, text="hello",
    )


def _usage_entry():
    """An entry whose `to_flow_data()` is empty — exercises the fallback branch."""
    return UsageEntry(
        id="e2", session_id="s1", timestamp="2026-01-01T00:00:00+00:00",
        worker="test", parent_id=None, io="input", count=10, model="m",
    )


# ── the three that DO share ─────────────────────────────────────────────────


@pytest.mark.parametrize("vendor", _VENDOR_MODULES)
def test_vendor_uses_the_shared_envelope(vendor):
    module = __import__(
        f"flow_sdk.builtin.agentic_process.cli_drivers.{vendor}.event_to_flowdata",
        fromlist=["_wrap_live"],
    )
    source = inspect.getsource(module._wrap_live)
    assert "return wrap_live(entry" in source, f"{vendor} re-inlined the envelope"


def test_all_three_stamp_an_identical_envelope():
    """Same entry, three vendors → same four attributes and the same process_entry."""
    frames = [_converter(v)(_assistant_entry()) for v in _VENDOR_MODULES]
    for frame in frames[1:]:
        assert frame.attributes.get("subtype") == frames[0].attributes.get("subtype")
        assert frame.attributes.get("observation-kind") == "live"
        assert frame.attributes.get("data-type") == frames[0].attributes.get("data-type")
        assert (frame.process_entry or {}).keys() == (frames[0].process_entry or {}).keys()


def test_the_empty_frames_fallback_still_carries_a_process_entry():
    """An entry with no FlowData of its own must still arrive as a full envelope."""
    for vendor in _VENDOR_MODULES:
        frame = _converter(vendor)(_usage_entry())
        assert frame.process_entry, f"{vendor} lost the process entry on the fallback path"
        assert frame.attributes["observation-kind"] == "live"
        assert frame.attributes["subtype"]


# ── the two divergences kept on purpose ─────────────────────────────────────


def test_claude_is_deliberately_not_a_caller():
    """Routing claude through the shared envelope would change every live frame.

    Its `_wrap_live` skips `derive_entry`, never reuses `entry.to_flow_data()`,
    and stamps 2 attributes rather than 4. This is negative space: the test
    exists to stop someone "finishing" the extraction.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.claude import event_to_flowdata as claude

    source = inspect.getsource(claude._wrap_live)
    # A CALL to the shared helper, not the def line's own name.
    assert "return wrap_live(" not in source
    assert "derive_entry" not in source
    # It stamps only element-type and data-type — no subtype, no observation-kind.
    assert '"subtype"' not in source
    assert '"observation-kind"' not in source


def test_the_element_mapping_is_a_parameter_not_a_shared_table():
    """copilot/opencode map only `tool_use`; claude/codex map a whole set.

    If these ever agree, it is because someone made a product decision — not
    because the envelope was refactored.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.codex import event_to_flowdata as codex
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode import event_to_flowdata as opencode

    # `file_write` is a tool call for codex and a status for opencode, today.
    assert codex._element_type_for_kind("file_write") != opencode._element_type_for_kind("file_write")
    # …while both agree on the kinds that were never in dispute.
    for kind in ("user_message", "assistant_message", "tool_use", "tool_result"):
        assert codex._element_type_for_kind(kind) == opencode._element_type_for_kind(kind)


def test_wrap_live_honours_the_supplied_mapping():
    """The parameter is actually consulted — not shadowed by a default."""
    sentinel = "SENTINEL_ELEMENT_TYPE"
    frame = wrap_live(_usage_entry(), lambda _kind: sentinel)
    assert frame.attributes["element-type"] == sentinel
