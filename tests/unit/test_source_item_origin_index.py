"""The ingestor's per-page identity read is an index lookup on the origin triple."""
from __future__ import annotations

import pytest

from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.sources import CloudOrigin


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_the_origin_lookup_uses_the_v3_index():
    from flow_sdk.db.drivers.db_driver import _driver_instances
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite

    await SourceItem.find_existing("ds", CloudOrigin(kind="k", namespace="n", key="x"))  # the schema exists
    conn = open_sqlite(_driver_instances["sqlite"].config.database, mode="ro")
    try:
        plan = conn.execute(
            "EXPLAIN QUERY PLAN SELECT id FROM entities WHERE type = 'source_item' "
            "AND json_extract(data, '$.data_source_id') = ? AND json_extract(data, '$.origin_kind') = ? "
            "AND json_extract(data, '$.origin_namespace') = ? AND json_extract(data, '$.origin_key') IN (?, ?)",
            ("ds", "k", "n", "x", "y"),
        ).fetchall()
    finally:
        conn.close()
    text = " ".join(str(row[-1]) for row in plan)
    assert "ix_entities_source_item_origin_v3" in text, text
