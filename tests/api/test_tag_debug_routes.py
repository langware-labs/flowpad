"""Observed-tags debug surface: emit → observe roundtrip over the API.

Both routes use the standard ApiResponse envelope so the frontend consumes
them through apiClient (path-only) — never raw fetch.
"""

import pytest

pytestmark = pytest.mark.asyncio


async def test_emit_then_observed_roundtrip(client):
    emitted = await client.post(
        "/api/v1/debug/emit_tag",
        json={"tag": "qa.observed.check", "target": "test:1"},
    )
    assert emitted.status_code == 200, emitted.text

    observed = await client.get("/api/v1/debug/observed_tags")
    assert observed.status_code == 200
    body = observed.json()
    assert body["status"] == "SUCCESS"
    stats = body["data"]["observed"]["qa.observed.check"]
    assert stats["count"] >= 1
    assert stats["last_target"] == "test:1"


async def test_emit_tag_validates_grammar_with_force_escape(client):
    bad = await client.post(
        "/api/v1/debug/emit_tag",
        json={"tag": "Not A Tag!", "target": "test:1"},
    )
    assert bad.json()["status"] == "FAIL"

    forced = await client.post(
        "/api/v1/debug/emit_tag",
        json={"tag": "Not A Tag!", "target": "test:1", "force": True},
    )
    assert forced.json()["status"] == "SUCCESS"
