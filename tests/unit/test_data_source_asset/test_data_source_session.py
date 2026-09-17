"""A source read by hand (``live.pages()`` + ``page.ack()``, ``live.items(**narrow)``) and the one-time
split of a stored list config into one source per entry."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional

import pytest

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource, migrate_list_configs
from flow_sdk.sources.base import CollectionSource
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.values.items import FeedItemData, SourceItemSpec
from flow_sdk.sources.values.query import DataQuery
from tests.fixtures.identity import index_path

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


class _ShelfQuery(DataQuery):
    shelf: str = ""
    min_n: int = 0


class _ShelfConfig(SourceConfig):
    retired_list = ("shelves", "shelf")

    shelf: str


class _Shelf(CollectionSource):
    provider = "session-shelf-test"
    Config = _ShelfConfig
    identity_config_key = "shelf"
    supported_queries = (_ShelfQuery,)
    page_size = 2
    durable_cursor = True

    def query(self) -> _ShelfQuery:
        return _ShelfQuery(shelf=str(self.config.get("shelf") or ""))

    async def _lookup(self, key: str) -> Any:
        return None

    async def _scan(self, query: Optional[DataQuery]) -> list[tuple[str, Any]]:
        return [(f"{n:02d}", n) for n in range(5) if n >= query.min_n]

    def _item(self, key: str, raw: Any) -> SourceItemSpec:
        # Dated so a merge can interleave: shelf "b" runs half an hour behind "a".
        when = datetime(2026, 1, 1, raw, 30 if self.query().shelf == "b" else 0, tzinfo=timezone.utc)
        return SourceItemSpec(origin=self.origin(key, self.query().shelf), data=FeedItemData(title=f"n{raw}", published_at=when))


@pytest.fixture
def scope(folder_db, fresh_user_scope):
    DataDriver.register(DataDriver.for_class(_Shelf, kind="datasource.test.shelf"))
    return fresh_user_scope


async def _source(name: str = "shelf a", shelf: str = "a") -> DataSource:
    source = DataDriver.loaded(_Shelf.provider).create_source({"shelf": shelf}, name=name)
    await source.save()
    return source


async def _received(scope, name: str, config: dict) -> DataSource:
    """A ``data_source.json`` an older build wrote, as the indexer reads it at boot."""
    folder = scope / "agentic-assets" / "data_source" / name.replace(" ", "_")
    folder.mkdir(parents=True)
    document = {"type": "data_source", "name": name, "data_driver_name": _Shelf.provider, "data_driver_config": config}
    (folder / "data_source.json").write_text(json.dumps(document), encoding="utf-8")
    await index_path("data_source", folder)
    (row,) = [r for r in await DataSource.get_all({"provider": _Shelf.provider}) if r.name == name]
    return row


async def _keys(pages) -> list[list[str]]:
    return [[item.origin.key for item in page.items] async for page in pages]


async def test_pages_start_from_the_stored_position_and_only_ack_moves_it(scope):
    source = await _source()

    async with await source.open() as live:
        assert await _keys(live.pages()) == [["00", "01"], ["02", "03"], ["04"]]
    assert (await DataSource.get_by_id(source.id)).cursor is None, "reading without ack moved the position"

    async with await source.open() as live:
        async for page in live.pages():
            await page.ack()
            break
    stored = await DataSource.get_by_id(source.id)
    assert stored.cursor is not None

    async with await stored.open() as live:
        assert await _keys(live.pages()) == [["02", "03"], ["04"]], "an acked page was read again"


async def test_items_narrow_the_query_and_never_move_the_position(scope):
    source = await _source()

    async with await source.open() as live:
        assert [item.origin.key async for item in live.items(min_n=3)] == ["03", "04"]
        with pytest.raises(ValueError, match="no field 'nope'"):
            [item async for item in live.items(nope=1)]
    assert (await DataSource.get_by_id(source.id)).cursor is None


async def test_reset_forgets_the_position(scope):
    source = await _source()
    source.cursor = "somewhere"
    await source.save_runtime()

    await source.reset()

    assert (await DataSource.get_by_id(source.id)).cursor is None


async def test_a_stored_list_config_splits_into_one_source_per_entry_once(scope):
    await _received(scope, "shelves", {"shelves": ["a", {"id": "b", "name": "Bee"}]})

    assert await migrate_list_configs() == 1
    assert await migrate_list_configs() == 0, "the split is one time"

    rows = {row.name: row.config for row in await DataSource.get_all({"provider": _Shelf.provider})}
    assert rows == {"shelves a": {"shelf": "a"}, "shelves Bee": {"shelf": "b"}}


async def test_a_single_entry_list_keeps_its_source(scope):
    legacy = await _received(scope, "one shelf", {"shelves": ["c"]})

    await migrate_list_configs()

    kept = await DataSource.get_by_id(legacy.id)
    assert kept is not None and kept.config == {"shelf": "c"}


async def test_a_list_that_cannot_split_parks_with_the_missing_field(scope):
    legacy = await _received(scope, "empty shelves", {"shelves": []})

    await migrate_list_configs()

    row = await DataSource.get_by_id(legacy.id)
    assert row is not None
    with pytest.raises(ValueError, match="config.shelf is required"):
        _ShelfConfig.validated(row.config)


# ── merge: several sources read as one ───────────────────────────────────────


async def test_pages_take_a_page_size(scope):
    source = await _source()
    async with await source.open() as live:
        assert await _keys(live.pages(page_size=5)) == [["00", "01", "02", "03", "04"]]


async def test_merged_pages_are_each_one_sources_and_ack_only_that_row(scope):
    from flow_sdk.ingest.session import merge

    a, b = await _source("shelf a", "a"), await _source("shelf b", "b")
    async with await merge(a, b).open() as live:
        pages = [page async for page in live.pages(page_size=5)]
        assert {page.source.name: [item.origin.key for item in page] for page in pages} == {
            "shelf a": ["00", "01", "02", "03", "04"], "shelf b": ["00", "01", "02", "03", "04"],
        }
        await next(page for page in pages if page.source is a).ack()
    assert (await DataSource.get_by_id(a.id)).cursor is None, "the last page has no next cursor"
    assert live.sources == [a, b]


async def test_merged_items_interleave_by_event_time_and_narrow_every_source(scope):
    from flow_sdk.ingest.session import merge

    a, b = await _source("shelf a", "a"), await _source("shelf b", "b")
    async with await merge(a, b).open() as live:
        keys = [(item.origin.namespace, item.origin.key) async for item in live.items(min_n=3)]
        assert keys == [("a", "03"), ("b", "03"), ("a", "04"), ("b", "04")]
        with pytest.raises(ValueError, match="shelf a: .*no field 'nope'"):
            [item async for item in live.items(nope=1)]
    assert (await DataSource.get_by_id(a.id)).cursor is None and (await DataSource.get_by_id(b.id)).cursor is None


async def test_a_reply_goes_through_the_source_that_owns_the_items_origin(scope):
    from flow_sdk.ingest.session import merge
    from tests.utils.fake_source import scripted_provider

    with scripted_provider("merge-alpha") as alpha, scripted_provider("merge-beta") as beta:
        alpha.push({"body": "from alpha", "author": "a@example.com"})
        beta.push({"body": "from beta", "author": "b@example.com"})
        sa = DataSource(name="alpha box", provider="merge-alpha", account_key="acct-alpha")
        sb = DataSource(name="beta box", provider="merge-beta", account_key="acct-beta")
        await sa.save()
        await sb.save()
        async with await merge(sa, sb).open() as live:
            items = [item async for item in live.items()]
            assert {live.source_of(item).name for item in items} == {"alpha box", "beta box"}
            for item in items:
                await live.reply(item, body="on it")
        assert [s["text"] for s in alpha.sent] == ["on it"] and [s["text"] for s in beta.sent] == ["on it"]


async def test_a_push_only_source_is_refused_at_open(scope):
    from flow_sdk.ingest.session import merge
    from flow_sdk.sources.base import Source

    class _PushOnly(Source):
        provider = "session-push-only-test"

    DataDriver.register(DataDriver.for_class(_PushOnly, kind="datasource.test.push"))
    push = DataSource(name="push box", provider=_PushOnly.provider, account_key="acct-push")
    await push.save()
    with pytest.raises(TypeError, match="push-only"):
        await merge(await _source(), push).open()
