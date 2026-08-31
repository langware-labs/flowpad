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

from flow_sdk.ingest.drivers.agent import AgentDriver

MANIFEST = (
    pathlib.Path(__file__).parents[2]
    / "flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_source/agent/data_source.json"
)


def _source(**config):
    return SimpleNamespace(config=config)


@pytest.mark.asyncio
async def test_the_declared_key_is_the_one_read():
    # The bug this pins: the manifest offered a field the driver never looked at.
    assert "segments" in json.loads(MANIFEST.read_text())["config"]
    got = await AgentDriver().segments(_source(segments=["INBOX", "SENT"]))
    assert [s.key for s in got] == ["INBOX", "SENT"]


@pytest.mark.asyncio
async def test_a_mailbox_becomes_its_own_cursor_label():
    got = await AgentDriver().segments(_source(segments=["SENT"]))
    assert [(s.key, s.label) for s in got] == [("SENT", "SENT")]


@pytest.mark.asyncio
async def test_inbox_when_nothing_is_named():
    assert [s.key for s in await AgentDriver().segments(_source())] == ["INBOX"]


@pytest.mark.asyncio
async def test_blank_entries_never_become_a_cursor():
    # An empty segment key would mint a cursor addressing nothing.
    got = await AgentDriver().segments(_source(segments=["INBOX", "", "  "]))
    assert [s.key for s in got] == ["INBOX"]


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy", [{"streams": ["ARCHIVE"]}, {"stream": "ARCHIVE"}])
async def test_rows_written_before_the_names_converged_keep_their_cursors(legacy):
    assert [s.key for s in await AgentDriver().segments(_source(**legacy))] == ["ARCHIVE"]


@pytest.mark.asyncio
async def test_segments_wins_over_the_legacy_spelling():
    got = await AgentDriver().segments(_source(segments=["INBOX"], streams=["ARCHIVE"]))
    assert [s.key for s in got] == ["INBOX"]
