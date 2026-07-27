"""GET /api/v1/subgraph/{projection} — the generic layer-2 route."""

import pytest

pytestmark = pytest.mark.asyncio


async def test_tag_projection_served(client):
    # Bless one tag through the API (the test client doesn't run the server
    # startup hook, so the system seed is not present here).
    created = await client.post(
        "/api/v1/graph/tag", json={"name": "--sg--.served.check"})
    assert created.status_code == 200, created.text

    resp = await client.get("/api/v1/subgraph/tag")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "SUCCESS"
    data = body["data"]
    assert data["projection"] == "tag"
    assert isinstance(data["nodes"], list) and isinstance(data["edges"], list)
    assert data["counts"] == {"nodes": len(data["nodes"]), "edges": len(data["edges"])}
    names = {n["id"] for n in data["nodes"] if n["type"] == "tag"}
    assert "--sg--.served.check" in names and "--sg--" in names  # + implied ancestor


async def test_root_param_scopes_and_tree_mode(client):
    await client.post("/api/v1/graph/tag", json={"name": "--sg--.scoped.leaf"})
    await client.post("/api/v1/graph/tag", json={"name": "--sgother--.stray"})

    resp = await client.get("/api/v1/subgraph/tag?root=--sg--.scoped&view=tree")
    data = resp.json()["data"]
    assert all(n["type"] == "tag" for n in data["nodes"])
    names = {n["id"] for n in data["nodes"]}
    assert "--sg--.scoped.leaf" in names and "--sgother--.stray" not in names
    assert all(e["topology"] == "hierarchy" for e in data["edges"])
    assert data["root"] == "tag---sg--.scoped"


async def test_unknown_projection_and_bad_params(client):
    resp = await client.get("/api/v1/subgraph/nope")
    body = resp.json()
    assert body["status"] == "FAIL"
    assert "tag" in (body.get("data") or {}).get("known", [])

    bad = await client.get("/api/v1/subgraph/tag?root=Not%20A%20Tag!")
    assert bad.json()["status"] == "FAIL"


def test_registry_roundtrip():
    from flow_sdk.subgraph import get_projection, known_projections, register_projection

    async def _dummy(params):
        return {"nodes": [], "edges": []}

    register_projection("qa-dummy", _dummy)
    assert get_projection("qa-dummy") is _dummy
    assert "qa-dummy" in known_projections()
