"""A ``_hub_only`` type (``llm_endpoint``) is served by the hub, whole, on the desktop.

It has no local row, so the per-entity reflection could not reach it: the People & teams
listing came back empty (the endpoint row spun forever), the id-less ``catalog`` failed to
parse (422), and every edit answered 404. The router now forwards any request on such a type
to the hub verbatim, with the hub's own status — and refuses it loudly when signed out.

Real request middleware + graph dispatcher; the hub is a stub ``CloudProxy``.
"""

from __future__ import annotations

import json

import pytest
from starlette.responses import JSONResponse

import flow_sdk.cloud_client as cloud_client
import flow_sdk.server.routes._hub_reflect as reflect_mod
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.llm_endpoint import LLMEndpoint  # noqa: F401 — registers the hub-only type
from flow_sdk.schema.type_info import register_all
from tests.unit._graph_client import call_local

register_all()

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


class _Hub:
    """Stands in for ``CloudProxy``: records what was forwarded, answers ``status``."""

    def __init__(self, status: int = 200, data=None):
        self.status, self.data, self.seen = status, data, []

    async def forward(self, request):
        body = await request.body()
        self.seen.append((request.method, request.url.path, request.url.query, json.loads(body) if body else None))
        return JSONResponse({"status": "SUCCESS" if self.status == 200 else "FAIL", "data": self.data}, self.status)


@pytest.fixture()
def hub(monkeypatch):
    def install(status: int = 200, data=None, logged_in: bool = True) -> _Hub:
        fake = _Hub(status, data)

        class FakeProxy:
            async def __call__(self, request):
                return await fake.forward(request)

        monkeypatch.setattr(cloud_client, "CloudProxy", FakeProxy)
        monkeypatch.setattr(reflect_mod, "is_logged_in", lambda: logged_in)
        return fake

    return install


@pytest.mark.asyncio
async def test_the_listing_is_the_hubs(hub):
    fake = hub(data=[{"id": "e1", "name": "Team 9a"}])

    resp = await call_local("GET", "llm_endpoint", params={"expand": "permissions"})

    assert resp.status_code == 200, resp.text
    assert resp.json()["data"] == [{"id": "e1", "name": "Team 9a"}]
    assert fake.seen == [("GET", "/api/v1/graph/llm_endpoint", "expand=permissions", None)]


@pytest.mark.asyncio
async def test_an_id_less_hub_action_is_forwarded_not_refused(hub):
    fake = hub(data=[])

    resp = await call_local("GET", "llm_endpoint/catalog")

    assert resp.status_code == 200, resp.text
    assert fake.seen[0][:2] == ("GET", "/api/v1/graph/llm_endpoint/catalog")


@pytest.mark.asyncio
async def test_an_edit_reaches_the_hub_and_its_refusal_comes_back(hub):
    fake = hub(status=403)
    endpoint_id = mint_uuid()

    resp = await call_local("PUT", f"llm_endpoint/{endpoint_id}", json={"name": "renamed"})

    assert resp.status_code == 403, resp.text
    assert fake.seen == [("PUT", f"/api/v1/graph/llm_endpoint/{endpoint_id}", "", {"name": "renamed"})]


@pytest.mark.asyncio
async def test_signed_out_it_fails_loudly_and_forwards_nothing(hub):
    fake = hub(logged_in=False)

    resp = await call_local("PUT", f"llm_endpoint/{mint_uuid()}", json={"name": "renamed"})

    assert resp.status_code == 409, resp.text
    assert "exists only on Flowpad Cloud" in resp.text
    assert fake.seen == []


@pytest.mark.asyncio
async def test_a_type_with_local_rows_is_not_forwarded(hub):
    fake = hub()

    await call_local("GET", "organization")

    assert fake.seen == []
