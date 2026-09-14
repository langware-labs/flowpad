"""The bridge: records lower to envelopes that lift back unchanged, files diff into refs, and
contract errors classify by what fixes them."""
from __future__ import annotations

import os
from types import SimpleNamespace

import pytest

from flow_sdk.ingest.driver import SegmentCursorView
from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.ingest.legacy_lift import lift
from flow_sdk.ingest.source_driver import SourceDriver
from flow_sdk.sources import CollectionSource, FeedItemData, FolderSource, NotFound, SourceItemSpec

pytestmark = pytest.mark.asyncio


class Feed(CollectionSource):
    provider = "feedtest"
    page_size = 1
    entries = {"a": "Alpha", "b": "Beta"}

    async def _lookup(self, key):
        return self.entries.get(key)

    async def _scan(self, query):
        return sorted(self.entries.items())

    def _item(self, key, title):
        return SourceItemSpec(origin=self.origin(key, "https://f.test/x.xml"), data=FeedItemData(title=title))


def _row(**config):
    return SimpleNamespace(id="ds-1", provider="feedtest", account_key="", config=config)


def _view(state=None):
    return SegmentCursorView(segment_key="root", state=state or {})


async def test_a_paged_record_traversal_lowers_to_envelopes_that_lift_back():
    result = await SourceDriver(Feed, kind="datasource.feed.test").fetch(_row(), _view())
    assert [(e.external_id, e.kind, e.name) for e in result.items] == [("a", "content.feed.item", "Alpha"), ("b", "content.feed.item", "Beta")]
    first = result.items[0]
    assert lift(None, first).origin == first.origin and first.origin.namespace == "https://f.test/x.xml"


async def test_a_reflecting_source_reports_changed_refs_then_quiet_then_the_removal(tmp_path):
    driver = SourceDriver(FolderSource, kind="datasource.fs.folder", ref_for=lambda s, key: os.path.join(s.root, key))
    (tmp_path / "a.md").write_text("one")
    row = _row(root=str(tmp_path))
    first = await driver.fetch(row, _view())
    assert first.refs == [os.path.join(os.path.realpath(tmp_path), "a.md")] and not first.unchanged

    quiet = await driver.fetch(row, _view(first.next_state))
    assert quiet.unchanged and quiet.refs == [] and quiet.tombstones == []

    (tmp_path / "a.md").unlink()
    gone = await driver.fetch(row, _view(quiet.next_state))
    assert gone.tombstones == first.refs


async def test_a_contract_error_classifies_by_what_fixes_it(tmp_path):
    driver = SourceDriver(FolderSource, kind="datasource.fs.folder", ref_for=lambda s, key: key)
    with pytest.raises(NotFound) as caught:
        await driver.fetch(_row(root=str(tmp_path / "missing")), _view())
    assert classify(caught.value)[:2] == (SourceHealth.CONFIG_ERROR, "not_found")
