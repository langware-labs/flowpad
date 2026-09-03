"""A manifest's ``required`` / ``pattern`` rules hold over HTTP, not only in
the dialog: ``DataSource.save`` raises ``ValueError`` naming the field and the
create route maps it to a 400."""
from __future__ import annotations

import pytest

from flow_sdk.builtin.data_source_spec import ConfigFieldSpec, DataSourceSpec

pytestmark = pytest.mark.asyncio


async def test_a_missing_required_field_is_a_400_naming_the_field(client):
    await DataSourceSpec(
        name="api_strict_provider", title="Strict",
        config={"root": ConfigFieldSpec(type="path", required=True), "feed": ConfigFieldSpec(pattern=r"^https?://")},
    ).save(notify=False)

    resp = await client.post("/api/v1/graph/data_source", json={"name": "s", "provider": "api_strict_provider", "config": {}})
    assert resp.status_code == 400, resp.text
    assert "config.root is required" in resp.text

    resp = await client.post("/api/v1/graph/data_source", json={"name": "s", "provider": "api_strict_provider", "config": {"root": "/x", "feed": "ftp://y"}})
    assert resp.status_code == 400, resp.text
    assert "config.feed is not valid: ftp://y" in resp.text

    resp = await client.post("/api/v1/graph/data_source", json={"name": "s", "provider": "api_strict_provider", "config": {"root": "/x", "feed": "http://y"}})
    assert resp.json().get("status") == "SUCCESS", resp.text
