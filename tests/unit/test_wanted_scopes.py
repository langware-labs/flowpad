"""A connect asks for more than reading exactly while a source here writes back.

``wanted_extra_scopes`` is what the consent adds to a provider's base scopes: the ``writes`` permissions
of the drivers whose sources are not read-only, bounded by the provider's ``optional_scopes``.
"""
from __future__ import annotations

import pytest

from flow_sdk.core.oauth.wanted_scopes import wanted_extra_scopes
from flow_sdk.ingest.testing import make_data_source

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

DRIVE = "https://www.googleapis.com/auth/drive"


@pytest.fixture(autouse=True)
async def no_drive_sources():
    """The test database is shared: start from no Drive source at all."""
    from flow_sdk.builtin.data_source import DataSource

    for row in await DataSource.get_all({"provider": "gdrive"}):
        await row.delete()


async def test_nothing_extra_until_a_source_writes_back():
    assert await wanted_extra_scopes("google") == []


async def test_a_drive_source_that_writes_back_asks_for_drive_and_a_read_only_one_does_not():
    reader = make_data_source("gdrive", read_only=True, config={"path": "GTM/Research"})
    await reader.save()
    assert await wanted_extra_scopes("google") == []

    writer = make_data_source("gdrive", config={"path": "GTM/Research"})
    await writer.save()
    assert await wanted_extra_scopes("google") == [DRIVE]
    assert await wanted_extra_scopes("googledrive") == [DRIVE], "the hub's name for the same connection"
    assert DRIVE in writer.connections.scopes("google") and DRIVE not in reader.connections.scopes("google")
