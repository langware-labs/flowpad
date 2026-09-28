"""A driver's ``Config`` rules hold over HTTP, not only in the dialog: ``DataSource.save`` raises
``ValueError`` naming the field and the create route maps it to a 400."""
from __future__ import annotations

import uuid
from typing import Annotated

import pytest
from pydantic import StringConstraints

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.driver_runtime import DRIVERS
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.families import RecordSource

pytestmark = pytest.mark.asyncio


class _StrictConfig(SourceConfig):
    root: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    feed: Annotated[str, StringConstraints(pattern=r"^https?://")] = "http://default"


class _Strict(RecordSource):
    provider = "api_strict_provider"
    Config = _StrictConfig


@pytest.fixture
def strict():
    DataDriver.register(DataDriver.for_class(_Strict))
    yield
    DRIVERS.unregister(_Strict.provider)


async def _create(client, config):
    return await client.post("/api/v1/graph/data_source", json={"name": f"s {uuid.uuid4().hex[:8]}", "provider": _Strict.provider, "config": config})


async def test_a_missing_required_field_is_a_400_naming_the_field(client, strict):
    resp = await _create(client, {})
    assert resp.status_code == 400, resp.text
    assert "config.root is required" in resp.text

    resp = await _create(client, {"root": "/x", "feed": "ftp://y"})
    assert resp.status_code == 400, resp.text
    assert "config.feed is not valid: ftp://y" in resp.text

    resp = await _create(client, {"root": "/x", "feed": "http://y"})
    assert resp.json().get("status") == "SUCCESS", resp.text
