"""Who owns a path is asked in one query, not one per asset-owning type.

``Entity.get_by_asset_ref`` (and ``origin_identity.resolve``) look across every type that owns an
asset path, ~46 of them. Asking each one cost a synced file several such fan-outs, and that was
most of the asset-dependencies doc page's 15 s budget. One statement over their rows names the
types worth asking; only those are queried.
"""
from __future__ import annotations

import re

import pytest
from sqlalchemy import event
from sqlalchemy.engine import Engine

from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.schema.data_spec.data_driver_spec import ReflectMode

from ._harness import poll, write_doc

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


class _Selects:
    """The SELECT statements issued inside the block (BEGIN/PRAGMA and writes are not counted)."""

    def __enter__(self):
        self.statements: list[str] = []
        event.listen(Engine, "before_cursor_execute", self._seen)
        return self

    def _seen(self, conn, cursor, statement, params, context, executemany):
        if re.match(r"\s*SELECT", statement, re.I):
            self.statements.append(statement)

    def __exit__(self, *exc):
        event.remove(Engine, "before_cursor_execute", self._seen)


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.asset_owner_fanout.rules: FAILING? a path-owner lookup must be
#       one probe query, not one per type - read this tag's rules
# flowpad:endcapsule tag
async def test_an_unowned_path_is_one_query(folder_db, tmp_path):
    assert len(Entity.asset_owner_classes()) > 10  # the fan-out this replaces
    with _Selects() as seen:
        assert await Entity.get_by_asset_ref(str(tmp_path / "nobody-owns-this.md")) is None
    assert len(seen.statements) == 1, f"{len(seen.statements)} queries for one unowned path"


async def test_an_owned_path_asks_only_the_type_that_holds_it(folder_db, watched, make_source):
    path = write_doc(watched)
    source, _proj = await make_source(ReflectMode.NONE.value)
    await poll(source)

    with _Selects() as seen:
        owner = await Entity.get_by_asset_ref(str(path))
    assert owner is not None and owner.asset_ref == str(path)
    # The probe, then the one holding type's row.
    assert len(seen.statements) == 2, f"{len(seen.statements)} queries for one owned path"
