"""OpenCode's tool→entry mapping must not diverge from the shared vocabulary.

`derivation/handlers/tool_maps._COMMON` exists so "this tool call was a search"
is decided once for every worker. The opencode parser maps tools by name in its
own ladder (opencode publishes a stable tool set, so name matching is sound) —
but where a name ALSO appears in the shared table, the two must agree, or the
same tool wears a different chip depending on which vendor ran it.

It diverged on day one: `websearch` was classed with grep/glob as a SearchEntry
while `_COMMON` maps it to WEB_FETCH.
"""

from __future__ import annotations

import pytest

from flow_sdk.transcript_analyzer.derivation.handlers.tool_maps import _COMMON
from flow_sdk.transcript_analyzer.entries import SearchEntry, WebFetchEntry
from flow_sdk.transcript_analyzer.parsers.opencode import OpenCodeParser


def _entry_for(tool_name: str, tool_input: dict):
    entries = OpenCodeParser(session_id="ses_x").feed(
        {
            "type": "tool_use",
            "timestamp": 1_700_000_000_000,
            "sessionID": "ses_x",
            "part": {
                "type": "tool",
                "tool": tool_name,
                "callID": "call_1",
                "state": {"status": "completed", "input": tool_input, "output": ""},
            },
        },
        0,
    )
    return entries[0] if entries else None


def test_websearch_is_a_web_entry_not_a_search_entry():
    entry = _entry_for("websearch", {"query": "how tall is everest"})
    assert isinstance(entry, WebFetchEntry), (
        "_COMMON maps websearch -> WEB_FETCH for every worker; opencode must agree"
    )
    # The query must survive — a web *search* has no url, and a blank chip is
    # what naively reusing the url-only field would produce.
    assert "everest" in entry.url


def test_webfetch_still_maps_to_a_web_entry():
    entry = _entry_for("webfetch", {"url": "https://example.com"})
    assert isinstance(entry, WebFetchEntry)
    assert entry.url == "https://example.com"


@pytest.mark.parametrize("tool", ["grep", "glob"])
def test_real_searches_are_still_search_entries(tool):
    entry = _entry_for(tool, {"pattern": "needle"})
    assert isinstance(entry, SearchEntry)


def test_no_opencode_tool_contradicts_the_shared_table():
    """The general guard: every name opencode classifies AND _COMMON knows must agree."""
    from flow_sdk.transcript_analyzer.parsers import opencode as mod

    # opencode's own buckets -> the shared semantic key they imply.
    implied = {
        **{t: "search" for t in mod._SEARCH_TOOLS},
        **{t: "web_fetch" for t in mod._FETCH_TOOLS},
        **{t: "agent_spawn" for t in mod._SPAWN_TOOLS},
    }
    conflicts = []
    for tool, key in implied.items():
        shared = _COMMON.get(tool)
        if shared is not None and shared != key:
            conflicts.append(f"{tool}: opencode={key!r} shared={shared!r}")
    assert not conflicts, "opencode diverges from the shared tool vocabulary: " + "; ".join(conflicts)
