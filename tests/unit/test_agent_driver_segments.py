"""The agent transport walks the mailboxes its config names.

The manifest declares `segments`; ingestion's whole vocabulary is `SegmentRef` /
`segment_key` / `IngestDriver.segments`. The driver read `streams` instead, so a
source configured with two mailboxes silently synced one INBOX and still reported
healthy — the worst shape of failure, because nothing surfaces it.
"""
from __future__ import annotations

import json
import pathlib
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.data_driver import DataDriver

MANIFEST = (
    pathlib.Path(__file__).parents[2]
    / "flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/agent/data_driver.json"
)


def _source(**config):
    config.setdefault("connector", "gmail")
    return SimpleNamespace(id="ds-agent", provider="agent", account_key="", config=config)


@pytest.mark.asyncio
async def test_the_declared_key_is_the_one_read():
    # The bug this pins: the manifest offered a field the driver never looked at.
    assert "segments" in json.loads(MANIFEST.read_text())["config"]
    got = await DataDriver.loaded("agent").segments(_source(segments=["INBOX", "SENT"]))
    assert [s.key for s in got] == ["INBOX", "SENT"]


@pytest.mark.asyncio
async def test_a_mailbox_becomes_its_own_cursor_label():
    got = await DataDriver.loaded("agent").segments(_source(segments=["SENT"]))
    assert [(s.key, s.label) for s in got] == [("SENT", "SENT")]


@pytest.mark.asyncio
async def test_stream_inbox_when_nothing_is_named():
    assert [s.key for s in await DataDriver.loaded("agent").segments(_source())] == ["INBOX"]


@pytest.mark.asyncio
async def test_blank_entries_never_become_a_cursor():
    # An empty segment key would mint a cursor addressing nothing.
    got = await DataDriver.loaded("agent").segments(_source(segments=["INBOX", "", "  "]))
    assert [s.key for s in got] == ["INBOX"]


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy", [{"streams": ["ARCHIVE"]}, {"stream": "ARCHIVE"}])
async def test_rows_written_before_the_names_converged_keep_their_cursors(legacy):
    assert [s.key for s in await DataDriver.loaded("agent").segments(_source(**legacy))] == ["ARCHIVE"]


@pytest.mark.asyncio
async def test_segments_wins_over_the_legacy_spelling():
    got = await DataDriver.loaded("agent").segments(_source(segments=["INBOX"], streams=["ARCHIVE"]))
    assert [s.key for s in got] == ["INBOX"]


@pytest.mark.asyncio
async def test_a_channel_connector_has_no_default_segment():
    from flow_sdk.sources.errors import Rejected as SourceError

    # Mail can assume INBOX; slack cannot guess a channel id.
    got = await DataDriver.loaded("agent").segments(_source(connector="slack", segments=["C0123ABCD"]))
    assert [s.key for s in got] == ["C0123ABCD"]
    with pytest.raises(SourceError):
        await DataDriver.loaded("agent").segments(_source(connector="slack"))


@pytest.mark.asyncio
@pytest.mark.parametrize("config", [{}, {"connector": ""}, {"connector": "jira"}])
async def test_a_missing_or_unknown_connector_is_a_config_error(config):
    from flow_sdk.sources.errors import Rejected as SourceError

    src = SimpleNamespace(id="ds-agent", provider="agent", account_key="", config=config)
    with pytest.raises(SourceError):
        await DataDriver.loaded("agent").segments(src)
