"""A connect asks for what ITS use point needs — never for what another source on the machine needs.

``scopes_for_source`` is what the consent adds to a connection's own scopes for one data source: its
driver's ``writes`` permissions when it writes back, or its store's row permissions when a dataset keeps
its rows there — bounded by the provider's ``optional_scopes``. ``group_for_source`` is the connector
scope group it reads through.
"""
from __future__ import annotations

import pytest

from flow_sdk.core.oauth.wanted_scopes import group_for_source, scopes_for_source
from flow_sdk.ingest.testing import make_data_source

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

DRIVE = "https://www.googleapis.com/auth/drive"
STORAGE_RW = "https://www.googleapis.com/auth/devstorage.read_write"


async def _saved(driver: str, **kw):
    source = make_data_source(driver, **kw)
    await source.save()
    return source


async def test_no_source_and_a_reader_ask_for_nothing_extra():
    reader = await _saved("gdrive", read_only=True, config={"path": "GTM/Research"})
    assert await scopes_for_source("google", "") == []
    assert await scopes_for_source("google", str(reader.id)) == []


async def test_a_writer_asks_for_drive_and_another_source_never_changes_a_readers_connect():
    reader = await _saved("gdrive", read_only=True, config={"path": "GTM/Research"})
    writer = await _saved("gdrive", config={"path": "GTM/Research"})
    assert await scopes_for_source("google", str(writer.id)) == [DRIVE]
    assert await scopes_for_source("googledrive", str(writer.id)) == [DRIVE], "the hub's name for the same connection"
    assert await scopes_for_source("google", str(reader.id)) == [], "a writer elsewhere does not widen the reader's consent"


async def test_a_source_holding_a_datasets_rows_asks_for_its_row_permission(monkeypatch):
    from flow_sdk.builtin.dataset import Dataset

    bucket = await _saved("gcs", name="rows-bucket", config={"bucket": "acme"})
    assert await scopes_for_source("google", str(bucket.id)) == [], "a bucket only read asks for nothing"

    async def kept_here(match, *a, **k):
        return [Dataset(name="leads")] if match == {"data_source": "rows-bucket"} else []

    monkeypatch.setattr(Dataset, "get_all", kept_here)
    assert await scopes_for_source("google", str(bucket.id)) == [STORAGE_RW]


async def test_the_google_drivers_read_through_the_drive_group():
    drive = await _saved("gdrive", read_only=True, config={"path": "x"})
    bucket = await _saved("gcs", config={"bucket": "acme"})
    assert await group_for_source(str(drive.id)) == "drive"
    assert await group_for_source(str(bucket.id)) == "drive"
    assert await group_for_source("") == ""
