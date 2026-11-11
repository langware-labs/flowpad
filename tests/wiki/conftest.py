"""Per-test DB reset for the wiki suite.

Wipes the `entities` and `links` tables before every test in this directory
so each scenario starts from an empty graph. Replaces the per-test
fixtures that test_resolver.py / test_store.py / etc. used to roll on their
own.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import delete as sa_delete

from flow_sdk.db import session
from flow_sdk.db.drivers.sqlite.connection import EntitySchema, LinksSchema
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root


@pytest_asyncio.fixture(autouse=True)
async def _wiki_db_reset():
    async with session() as s:
        await s.execute(sa_delete(LinksSchema))
        await s.execute(sa_delete(EntitySchema))
    yield


@pytest.fixture()
def records_root(tmp_path):
    """Record homes under the test's tmp dir, restored afterwards."""
    original = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    yield
    set_default_records_root(original)
