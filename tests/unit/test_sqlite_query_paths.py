"""Dotted field paths are first-class in the SQLite driver; per-type indexes are declared on TypeInfo.

- A dotted filter (``origin.key``) means the same thing pushed to SQL and evaluated in Python.
- A dotted ORDER BY runs in SQL, so LIMIT/OFFSET stay in SQL.
- A field name that is not a plain identifier path raises instead of reaching SQL text.
- ``TypeInfo.indexes`` declarations are built idempotently; a removed one is dropped; the
  hand-written names they replaced are gone; the SourceItem natural-key lookup still uses an index.
"""

import pytest
import pytest_asyncio
from sqlalchemy import text

from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.db.drivers.sqlite.sqlite_driver import (
    _RETIRED_ENTITY_INDEXES,
    SQLiteDBDriver,
    declared_index_sql,
    json_path_sql,
)
from flow_sdk.fs_store.schema_registry import SchemaRegistry


@pytest_asyncio.fixture
async def driver(tmp_path):
    drv = SQLiteDBDriver(DBConfig(database=str(tmp_path / "test.db")))
    await drv.open()
    yield drv
    await drv.close()


async def _seed(driver):
    from flow_sdk.builtin.source_item import SourceItem
    from flow_sdk.sources.values.origin import CloudOrigin

    for key, body in (("k2", "b"), ("k1", "a"), ("k3", "c")):
        await driver.save(
            SourceItem(
                data_source_id="ds",
                body=body,
                recipients=["x"] if key != "k3" else [],
                origin=CloudOrigin(kind="mail", namespace="acct", key=key),
            )
        )
    return SourceItem.get_type()


def _eq(field, value):
    return ExpressionNode(op=QueryOp.EQ, operands=[field, value])


def _prop_in(value, prop):
    return ExpressionNode(op=QueryOp.IN, operands=[value, ExpressionNode(op=QueryOp.PROP, operands=[prop])])


async def test_dotted_filter_in_python_fallback(driver):
    t = await _seed(driver)
    # The PROP leaf is not SQL-pushable, so the whole AND is re-evaluated in Python.
    match = ExpressionNode(op=QueryOp.AND, operands=[_eq("origin.key", "k1"), _prop_in("x", "recipients")])
    assert driver._expr_to_sql(match, [0])[1] is False
    rows = await driver.get_all(QueryFilter(type=t, match=match))
    assert [r.body for r in rows] == ["a"]
    miss = ExpressionNode(op=QueryOp.AND, operands=[_eq("origin.key", "k3"), _prop_in("x", "recipients")])
    assert await driver.get_all(QueryFilter(type=t, match=miss)) == []

    # Paging runs AFTER the Python filter, in SQL order: k3/c (no recipient) is not counted by the offset.
    python_only = _prop_in("x", "recipients")
    page = await driver.get_all(QueryFilter(type=t, match=python_only, order_by=[{"body": "desc"}], limit=1, offset=1))
    assert [r.body for r in page] == ["a"]
    # Equal keys page by id, the hub's tie-break: every row once, none repeated.
    all_ids = sorted(r.id for r in await driver.get_all(QueryFilter(type=t, match=python_only)))
    paged_ids = []
    for offset in range(len(all_ids)):
        same = QueryFilter(type=t, match=python_only, order_by=[{"data_source_id": "asc"}], limit=1, offset=offset)
        paged_ids += [r.id for r in await driver.get_all(same)]
    assert paged_ids == all_ids
    # A page with no order is newest first.
    newest = await driver.get_all(QueryFilter(type=t, match=python_only, limit=2))
    assert [r.body for r in newest] == ["a", "b"]


class TestDottedPaths:
    @pytest.mark.asyncio
    async def test_dotted_filter_in_sql(self, driver):
        t = await _seed(driver)
        rows = await driver.get_all(QueryFilter(type=t, match=_eq("origin.key", "k1")))
        assert [r.body for r in rows] == ["a"]

    def test_python_evaluator_walks_paths_and_keeps_flat_keys(self, driver):
        attrs = {"origin": {"key": "k1"}, "origin.key": None, "body": "a", "tags": [{"n": 1}, {"n": 2}]}
        # A flat key spelled with a dot wins over the walk (field_of's rule).
        assert driver._evaluate_expression(_eq("origin.key", "k1"), attrs) is False
        assert driver._evaluate_expression(_eq("origin.key", "k1"), {"origin": {"key": "k1"}}) is True
        assert driver._evaluate_expression(_eq("body", "a"), attrs) is True
        assert driver._evaluate_expression(_eq("tags.*.n", 2), attrs) is True
        assert driver._evaluate_expression(_eq("tags.1.n", 2), attrs) is True
        assert driver._evaluate_expression(_eq("tags.*.n", 3), attrs) is False

    @pytest.mark.asyncio
    async def test_dotted_order_by_keeps_limit_in_sql(self, driver):
        t = await _seed(driver)
        assert driver._build_sql_order_by([{"origin.key": "desc"}])
        rows = await driver.get_all(QueryFilter(type=t, order_by=[{"origin.key": "desc"}], limit=2))
        assert [r.body for r in rows] == ["c", "b"]
        rows = await driver.get_all(QueryFilter(type=t, order_by=[{"origin.key": "asc"}], limit=1, offset=1))
        assert [r.body for r in rows] == ["b"]

    @pytest.mark.asyncio
    async def test_flat_fields_unchanged(self, driver):
        t = await _seed(driver)
        rows = await driver.get_all(QueryFilter(type=t, match=_eq("body", "c")))
        assert [r.body for r in rows] == ["c"]
        rows = await driver.get_all(QueryFilter(type=t, order_by=[{"body": "asc"}]))
        assert [r.body for r in rows] == ["a", "b", "c"]
        assert [r.body for r in driver._apply_sorting(rows, ["-origin.key"])] == ["c", "b", "a"]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("bad", ["x') OR 1=1 --", "a..b", "1abc", "a.b-c", ""])
    async def test_bad_field_name_raises(self, driver, bad):
        t = await _seed(driver)
        with pytest.raises(ValueError):
            await driver.get_all(QueryFilter(type=t, match=_eq(bad, "v")))
        with pytest.raises(ValueError):
            await driver.get_all(QueryFilter(type=t, order_by=[{bad: "asc"}]))
        with pytest.raises(ValueError):
            await driver.get_by_prop(bad, "v", t)

    def test_json_path_sql(self):
        assert json_path_sql("payload.conversation.key") == "json_extract(data, '$.payload.conversation.key')"


async def _index_names(driver):
    async with driver.session_factory() as session:
        result = await session.execute(text("SELECT name FROM sqlite_master WHERE type = 'index'"))
        return {row[0] for row in result.fetchall()}


class TestDeclaredIndexes:
    @pytest.mark.asyncio
    async def test_declared_indexes_exist_and_old_names_are_gone(self, driver):
        names = await _index_names(driver)
        desired = declared_index_sql(SchemaRegistry, driver._COLUMN_FIELDS)
        assert set(desired) <= names
        assert not names & set(_RETIRED_ENTITY_INDEXES)
        # The ported ones: SourceItem (2), MessageThread (3), ConsumerPosition, SourceChange.
        by_type = {}
        for name in desired:
            for t in ("source_item", "message_thread", "consumer_position", "source_change"):
                if name.startswith(f"ix_entities_{t}_"):
                    by_type[t] = by_type.get(t, 0) + 1
        assert by_type == {"source_item": 3, "message_thread": 1, "consumer_position": 1, "source_change": 1}

    @pytest.mark.asyncio
    async def test_resync_is_noop_and_removed_declaration_drops(self, driver):
        before = await _index_names(driver)
        async with driver.engine.begin() as conn:
            await driver._sync_declared_indexes(conn)
        assert await _index_names(driver) == before

        info = SchemaRegistry.get("consumer_position")
        saved = info.indexes
        try:
            info.indexes = ()
            async with driver.engine.begin() as conn:
                await driver._sync_declared_indexes(conn)
            after = await _index_names(driver)
            gone = before - after
            assert len(gone) == 1 and next(iter(gone)).startswith("ix_entities_consumer_position_")
        finally:
            info.indexes = saved
        async with driver.engine.begin() as conn:
            await driver._sync_declared_indexes(conn)
        assert await _index_names(driver) == before

    @pytest.mark.asyncio
    async def test_retired_hand_written_index_is_dropped_on_open(self, tmp_path):
        drv = SQLiteDBDriver(DBConfig(database=str(tmp_path / "old.db")))
        await drv.open()
        async with drv.session_factory() as session:
            await session.execute(text(
                "CREATE INDEX ix_entities_source_item_origin_v3 ON entities(json_extract(data, '$.x')) "
                "WHERE type = 'source_item'"
            ))
            await session.commit()
        await drv.close()
        await drv.open()
        try:
            assert "ix_entities_source_item_origin_v3" not in await _index_names(drv)
        finally:
            await drv.close()

    @pytest.mark.asyncio
    async def test_source_item_natural_key_lookup_uses_an_index(self, driver):
        async with driver.session_factory() as session:
            result = await session.execute(text(
                "EXPLAIN QUERY PLAN SELECT id FROM entities WHERE type = 'source_item' "
                "AND json_extract(data, '$.data_source_id') = 'ds' "
                "AND json_extract(data, '$.origin_kind') = 'k' "
                "AND json_extract(data, '$.origin_namespace') = 'n' "
                "AND json_extract(data, '$.origin_key') = 'x'"
            ))
            plan = " ".join(str(row[-1]) for row in result.fetchall())
        assert "ix_entities_source_item_" in plan, plan

    @pytest.mark.asyncio
    async def test_source_item_identity_lookup_uses_an_index(self, driver):
        async with driver.session_factory() as session:
            result = await session.execute(text(
                "EXPLAIN QUERY PLAN SELECT id FROM entities WHERE type = 'source_item' "
                "AND json_extract(data, '$.data_source_id') = 'ds' "
                "AND json_extract(data, '$.item_scope') = 's' "
                "AND json_extract(data, '$.item_key') = 'x'"
            ))
            plan = " ".join(str(row[-1]) for row in result.fetchall())
        assert "ix_entities_source_item_" in plan, plan


class TestFtsSources:
    def test_fts_sources_walk_paths_and_read_accessors(self):
        from types import SimpleNamespace

        from flow_sdk.db.drivers.sqlite.sqlite_driver import FtsEntry
        from flow_sdk.fs_store.serializer.record import FTS_WEIGHT_CONTENT, FTS_WEIGHT_TITLE, fts_content

        class Row(SimpleNamespace):
            id = "r1"

            def get_type(self):
                return "source_item"

            @property
            def summary(self):   # an accessor is a property (``Payload.item_*``)
                return "from accessor"

        row = Row(name="n", payload={"subject": "Hello", "body": {"text": "deep"}})
        info = SimpleNamespace(
            fts_content=("payload.body.text",),
            fts={"payload.subject": FTS_WEIGHT_TITLE, "summary": FTS_WEIGHT_CONTENT},
        )
        assert fts_content(row, info) == "deep\nfrom accessor"
        entry = FtsEntry.from_entity(row, info=info)
        assert entry.title == "Hello" and entry.name == "n"
        # Flat names, no ``fts``: unchanged.
        assert fts_content(SimpleNamespace(body="b", links=["x", "y"]), SimpleNamespace(fts_content=("body", "links"))) == "b\nx y"
